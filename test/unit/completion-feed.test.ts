import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import type { WorkerCompletion } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sa-feed-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  for (const value of ["worker-one", "worker-two"]) {
    const id = workerId(value);
    await store.create(
      {
        version: 1,
        id,
        ownerSessionKey: "session-a",
        tmuxSession: `pi-sa-${id}`,
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "test" },
      },
      {
        version: 1,
        id,
        status: "running",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
  }
  return { root, store };
}

function completion(
  id: "worker-one" | "worker-two",
  turn: number,
  status: "completed" | "failed" = "completed",
): WorkerCompletion {
  return {
    version: 1,
    id: workerId(id),
    turn,
    commandSeq: turn,
    resultSeq: turn,
    status,
    summary: status === "failed" ? "failed" : `turn ${turn}`,
    hasDetails: status === "completed",
    completedAt: `2026-01-01T00:00:0${turn}Z`,
  };
}

describe("durable completion feed", () => {
  it("redelivers before ack and resumes after ack across manager restarts", async () => {
    const { root, store } = await fixture();
    await store.writeCompletion(completion("worker-one", 1));

    const first = await new Manager({
      store: new ProtocolStore(root),
    }).completions({
      consumer: "pi-extension",
      ownerSessionKey: "session-a",
    });
    expect(first.map((entry) => entry.cursor)).toEqual([1]);

    const beforeAck = await new Manager({
      store: new ProtocolStore(root),
    }).completions({ consumer: "pi-extension", ownerSessionKey: "session-a" });
    expect(beforeAck).toEqual(first);

    await new Manager({ store: new ProtocolStore(root) }).ackCompletion(
      "pi-extension",
      "session-a",
      first[0]!.cursor,
    );
    expect(
      await new Manager({ store: new ProtocolStore(root) }).completions({
        consumer: "pi-extension",
      ownerSessionKey: "session-a",
      }),
    ).toEqual([]);
  });

  it("orders close completions and preserves multiple turns and failures", async () => {
    const { root, store } = await fixture();
    await Promise.all([
      store.writeCompletion(completion("worker-one", 1)),
      store.writeCompletion(completion("worker-two", 1, "failed")),
    ]);
    await store.writeCompletion(completion("worker-one", 2));

    const entries = await new ProtocolStore(root).completions({
      consumer: "other-consumer",
      ownerSessionKey: "session-a",
    });
    expect(entries.map((entry) => entry.cursor)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.completion.status).sort()).toEqual([
      "completed",
      "completed",
      "failed",
    ]);
    expect(
      entries
        .filter((entry) => entry.completion.id === "worker-one")
        .map((entry) => entry.completion.turn),
    ).toEqual([1, 2]);
  });

  it("resumes polling from a durable byte offset instead of reparsing history", async () => {
    const { root, store } = await fixture();
    for (let turn = 1; turn <= 40; turn++) {
      await store.writeCompletion(completion("worker-one", turn));
    }
    const first = await store.completions({
      consumer: "incremental",
      ownerSessionKey: "session-a",
    });
    for (const entry of first) {
      await store.ackCompletion(
        "incremental",
        "session-a",
        entry.cursor,
      );
    }
    await store.writeCompletion(completion("worker-one", 41));

    const restarted = new ProtocolStore(root);
    const incremental = vi.spyOn(restarted as any, "readCompletionFeedFrom");
    const full = vi.spyOn(restarted as any, "readCompletionFeed");
    const next = await restarted.completions({
      consumer: "incremental",
      ownerSessionKey: "session-a",
    });
    expect(next.map((entry) => entry.completion.turn)).toEqual([41]);
    expect(incremental).toHaveBeenCalledWith(expect.any(Number), 40);
    expect(incremental.mock.calls[0]![0]).toBeGreaterThan(0);
    expect(full).not.toHaveBeenCalled();
  });

  it("deduplicates producer retries and keeps independent consumer cursors", async () => {
    const { store } = await fixture();
    const value = completion("worker-one", 1);
    await store.writeCompletion(value);
    await store.writeCompletion(value);

    expect(await store.completions({ consumer: "first", ownerSessionKey: "session-a" })).toHaveLength(1);
    await store.ackCompletion("first", "session-a", 1);
    expect(await store.completions({ consumer: "first", ownerSessionKey: "session-a" })).toEqual([]);
    expect(await store.completions({ consumer: "second", ownerSessionKey: "session-a" })).toHaveLength(1);
    await expect(store.ackCompletion("first", "session-a", 2)).rejects.toMatchObject({
      code: "INVALID_COMPLETION_CURSOR",
    });
  });

  it("worker ID reuse: recreated worker with same ID publishes completion independently with different instanceId", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-reuse-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const manager = new Manager({
      store,
      tmux: {
        create: vi.fn(async () => "%0"),
        terminate: vi.fn(async () => {}),
        exists: vi.fn(async () => false),
      } as any,
    });
    const id = "reuse-worker";

    // 1. Create worker with requested ID reuse-worker
    await manager.spawn({ task: "first incarnation" }, root, id, "session-a");
    const firstMeta = await store.readMeta(workerId(id));
    expect(firstMeta.instanceId).toBeDefined();

    // 2. Publish a completion
    await store.writeCompletion({
      version: 1,
      id: workerId(id),
      turn: 1,
      resultSeq: 1,
      status: "completed",
      summary: "first completion",
      hasDetails: false,
      completedAt: "2026-01-01T00:00:00Z",
    });

    // 3. Mark terminal and delete worker
    await store.writeState({
      version: 1,
      id: workerId(id),
      status: "stopped",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 1,
    });
    await manager.delete(id);

    // 4. Recreate worker with the same requested ID
    await manager.spawn({ task: "second incarnation" }, root, id, "session-a");
    const secondMeta = await store.readMeta(workerId(id));
    expect(secondMeta.instanceId).toBeDefined();
    expect(secondMeta.instanceId).not.toBe(firstMeta.instanceId);

    // 5. Publish a completion with the same turn/resultSeq/status values
    await store.writeCompletion({
      version: 1,
      id: workerId(id),
      turn: 1,
      resultSeq: 1,
      status: "completed",
      summary: "second completion",
      hasDetails: false,
      completedAt: "2026-01-01T00:01:00Z",
    });

    // 6. Query completion feed
    const feed = await store.completions({
      consumer: "test",
      ownerSessionKey: "session-a",
    });
    const completions = feed.filter((e) => e.completion.id === id);
    expect(completions).toHaveLength(2);

    const [first, second] = completions;
    expect(first!.completion.instanceId).toBe(firstMeta.instanceId);
    expect(second!.completion.instanceId).toBe(secondMeta.instanceId);
    expect(first!.completion.instanceId).not.toBe(second!.completion.instanceId);
    expect(first!.completion.summary).toBe("first completion");
    expect(second!.completion.summary).toBe("second completion");
  });
});
