import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Recovery } from "../../src/manager/recovery.js";
import type { WorkerCompletion } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sa-bounded-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  const id = workerId("bounded-worker");
  await store.create(
    {
      version: 1,
      id,
      tmuxSession: "pi-sa-bounded",
      createdAt: new Date().toISOString(),
      cwd: root,
      launch: { task: "bounded" },
    },
    {
      version: 1,
      id,
      status: "waiting",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 0,
    },
  );
  return { root, store, id };
}

function makeCompletion(
  id: string,
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
    summary: `Done turn ${turn}`,
    hasDetails: false,
    completedAt: new Date().toISOString(),
  };
}

describe("bounded I/O operations", () => {
  it("recovery uses incremental cursor and does not reread full 1,000 events when state cache exists", async () => {
    const { root, store, id } = await fixture();

    // Directly write 1,000 events into events.jsonl
    const totalEvents = 1000;
    const lines = Array.from({ length: totalEvents }, (_, i) =>
      JSON.stringify({
        version: 1,
        seq: i + 1,
        at: new Date().toISOString(),
        type: "assistant_delta",
        data: `delta-${i + 1}`,
      }),
    ).join("\n") + "\n";
    await writeFile(store.path(id, "events.jsonl"), lines, "utf8");

    // Save cached state at seq 1000
    await store.writeState({
      version: 1,
      id,
      status: "waiting",
      turn: 10,
      lastCommandSeq: 10,
      lastEventSeq: 1000,
      lastEventAt: new Date().toISOString(),
    });

    await store.writeMeta({
      version: 1,
      id,
      tmuxSession: "pi-sa-bounded",
      createdAt: new Date().toISOString(),
      cwd: root,
      launch: { task: "bounded" },
      runnerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
    });

    const tmux = {
      exists: vi.fn(async () => true),
      hasSession: vi.fn(async () => true),
      sessionEnv: vi.fn(async () => ({})),
      windowActivity: vi.fn(async () => 0),
    } as any;

    const recovery = new Recovery(store, tmux);
    const readLogSpy = vi.spyOn(store, "readLog");

    const recovered = await recovery.recover(id);

    // Assert that readLog was called with the cursor cached.lastEventSeq + 1 (1001)
    expect(readLogSpy).toHaveBeenCalledWith(id, "events", 1001);

    // Ensure it was NEVER called without fromSeq (which would read all 1,000 events)
    const fullReads = readLogSpy.mock.calls.filter(
      (args) => args[0] === id && args[1] === "events" && args[2] === undefined,
    );
    expect(fullReads).toHaveLength(0);

    expect(recovered.lastEventSeq).toBe(1000);
    expect(recovered.turn).toBe(10);
  });

  it("completion N+1 uses incremental index offset instead of reparsing all previous completions", async () => {
    const { store } = await fixture();

    // Write N completions (e.g. 20 completions)
    const initialCount = 20;
    for (let i = 1; i <= initialCount; i++) {
      await store.writeCompletion(makeCompletion(`worker-${i}`, 1));
    }

    const fullFeedSpy = vi.spyOn(store as any, "readCompletionFeed");
    const incrementalFeedSpy = vi.spyOn(store as any, "readCompletionFeedFrom");

    // Write completion N+1: when index is already up to date, zero feed reads occur
    await store.writeCompletion(makeCompletion("worker-21", 1));
    expect(fullFeedSpy).not.toHaveBeenCalled();
    expect(incrementalFeedSpy).not.toHaveBeenCalled();

    // Now simulate an external write to completions.jsonl
    const externalEntry = {
      cursor: 22,
      version: 1,
      ownerSessionKey: null,
      completion: makeCompletion("worker-external", 1),
    };
    await appendFile(
      join(store.root, "completions.jsonl"),
      JSON.stringify(externalEntry) + "\n",
      "utf8",
    );

    // When writing completion 23, it catches up incrementally via readCompletionFeedFrom, NOT full scan
    await store.writeCompletion(makeCompletion("worker-23", 1));
    expect(fullFeedSpy).not.toHaveBeenCalled();
    expect(incrementalFeedSpy).toHaveBeenCalledTimes(1);

    // Verify all completions exist in the feed
    const feed = await (store as any).readCompletionFeed();
    expect(feed).toHaveLength(23);
  });
});
