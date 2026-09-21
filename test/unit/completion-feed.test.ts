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
});
