import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionNotifier } from "../../src/extension/completion-notifier.js";
import { Manager } from "../../src/manager/manager.js";
import { Recovery } from "../../src/manager/recovery.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("supervisor hard-death failures", () => {
  it("publishes a durable failure completion when a worker dies ungracefully (SIGKILL / pane disappears)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hard-death-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("hard-dead-1");
    const ownerSessionKey = "session-owner-123";

    await store.create(
      {
        version: 1,
        id,
        ownerSessionKey,
        tmuxSession: "pi-sa-hard-dead-1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "compute-critical-task" },
        runnerPid: 999999, // dead pid
        heartbeatAt: "2026-01-01T00:00:00Z",
      },
      {
        version: 1,
        id,
        status: "running",
        turn: 1,
        lastCommandSeq: 1,
        lastEventSeq: 1,
      },
    );

    // tmux session is also gone (simulating pane / process killed)
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const tmux = new TmuxAdapter(exec);

    // Recovery runs with orphanGraceMs: 0 (immediate orphaning)
    const recovery = new Recovery(store, tmux, { orphanGraceMs: 0 });
    const state = await recovery.recover(id);
    expect(state.status).toBe("orphaned");

    // Verify durable failure result was written
    const result = await store.readResult(id);
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      status: "failed",
      turn: 1,
      commandSeq: 1,
      text: expect.stringContaining("Worker process terminated unexpectedly"),
    });

    // Verify durable failed completion was published to the feed for owner
    const feedEntries = await store.completions({
      consumer: "test-parent",
      ownerSessionKey,
    });
    expect(feedEntries).toHaveLength(1);
    expect(feedEntries[0]!.completion).toMatchObject({
      id: "hard-dead-1",
      turn: 1,
      status: "failed",
      summary: expect.stringContaining("Worker process terminated unexpectedly"),
    });

    // Test delivery through CompletionNotifier into parent session
    const delivered: any[] = [];
    const pi = {
      sendMessage: vi.fn((msg) => delivered.push(msg)),
    };
    const manager = new Manager({ store, tmux });
    const notifier = new CompletionNotifier(manager, pi as any, {
      ownerSessionKey,
    });
    await notifier.poll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].details).toMatchObject({
      id: "hard-dead-1",
      turn: 1,
      status: "failed",
    });

    // Running recovery again must NOT publish duplicate failure completions
    await recovery.recover(id);
    const feedAgain = await store.completions({
      consumer: "second-consumer",
      ownerSessionKey,
    });
    expect(feedAgain).toHaveLength(1);
  });

  it("deduplicates failure if runner and supervisor race to report failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-race-failure-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("race-dead-1");
    const ownerSessionKey = "session-owner-456";

    await store.create(
      {
        version: 1,
        id,
        ownerSessionKey,
        tmuxSession: "pi-sa-race-dead-1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "race-task" },
        runnerPid: 999999,
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

    // Runner managed to write a failed completion first before fully exiting
    const failedEvent = await store.appendEvent(id, {
      type: "failed",
      data: "Runner caught exit",
    });
    await store.writeState({
      version: 1,
      id,
      status: "failed",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: failedEvent.seq,
    });
    await store.writeResult({
      version: 1,
      id,
      status: "failed",
      turn: 1,
      commandSeq: 1,
      resultSeq: 2,
      eventSeq: 2,
      text: "Runner caught exit",
      completedAt: new Date().toISOString(),
    });
    await store.writeCompletion(
      {
        version: 1,
        id,
        turn: 1,
        commandSeq: 1,
        resultSeq: 2,
        status: "failed",
        summary: "Runner caught exit",
        hasDetails: true,
        completedAt: new Date().toISOString(),
      },
      ownerSessionKey,
    );

    // Now supervisor recovery runs
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const recovery = new Recovery(store, new TmuxAdapter(exec), {
      orphanGraceMs: 0,
    });
    const state = await recovery.recover(id);

    // Recovery sees it's already terminal ('failed'), so does not overwrite or duplicate
    expect(state.status).toBe("failed");
    const entries = await store.completions({
      consumer: "audit",
      ownerSessionKey,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.completion.summary).toBe("Runner caught exit");
  });
});
