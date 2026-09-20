import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompletionNotifier,
  formatCompletionNotification,
  subagentCompletionPayload,
} from "../../src/extension/completion-notifier.js";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import type { WorkerCompletion } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sa-notifier-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  const manager = new Manager({ store });
  return { root, store, manager };
}

function makeCompletion(
  id: string,
  turn: number,
  status: "completed" | "failed" = "completed",
  summary = `Turn ${turn} finished`,
): WorkerCompletion {
  return {
    version: 1,
    id: workerId(id),
    turn,
    commandSeq: turn,
    resultSeq: turn,
    status,
    summary,
    hasDetails: true,
    completedAt: "2026-01-01T00:00:00Z",
  };
}

describe("completion notifier", () => {
  it("formats notification content and semantic payload correctly", () => {
    const completion = makeCompletion(
      "agent-abc",
      1,
      "completed",
      "Implemented feature X with 5 tests.",
    );

    expect(formatCompletionNotification(completion)).toBe(
      `[subagent agent-abc completed]\nImplemented feature X with 5 tests.\nFull result available via subagent({ action: "result", id: "agent-abc" }).`,
    );

    expect(subagentCompletionPayload(completion)).toEqual({
      type: "subagent_completed",
      id: "agent-abc",
      turn: 1,
      status: "completed",
      summary: "Implemented feature X with 5 tests.",
      hasDetails: true,
    });
  });

  it("delivers completion to pi session and acks cursor", async () => {
    const { store, manager } = await fixture();
    const completion = makeCompletion(
      "worker-1",
      1,
      "completed",
      "Done task 1",
    );
    await store.writeCompletion(completion);

    const sendMessage = vi.fn();
    const pi = { sendMessage };

    const notifier = new CompletionNotifier(manager, pi as any);
    await notifier.poll();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "subagent_completed",
        content: formatCompletionNotification(completion),
        display: true,
        details: {
          type: "subagent_completed",
          id: "worker-1",
          turn: 1,
          status: "completed",
          summary: "Done task 1",
          hasDetails: true,
        },
      },
      { deliverAs: "followUp" },
    );

    // Verify cursor is acked: polling again sends nothing
    await notifier.poll();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers failure notifications without requiring log scraping", async () => {
    const { store, manager } = await fixture();
    const failure = makeCompletion(
      "worker-fail",
      2,
      "failed",
      "Process exited with code 1",
    );
    await store.writeCompletion(failure);

    const sendMessage = vi.fn();
    const pi = { sendMessage };

    const notifier = new CompletionNotifier(manager, pi as any);
    await notifier.poll();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "subagent_completed",
        content: formatCompletionNotification(failure),
        display: true,
        details: {
          type: "subagent_completed",
          id: "worker-fail",
          turn: 2,
          status: "failed",
          summary: "Process exited with code 1",
          hasDetails: true,
        },
      },
      { deliverAs: "followUp" },
    );
  });

  it("does not ack cursor if sendMessage throws, and retries on next poll", async () => {
    const { store, manager } = await fixture();
    const completion = makeCompletion("worker-err", 1);
    await store.writeCompletion(completion);

    let fail = true;
    const errors: unknown[] = [];
    const sendMessage = vi.fn(() => {
      if (fail) throw new Error("session unavailable");
    });
    const pi = { sendMessage };

    const notifier = new CompletionNotifier(manager, pi as any, {
      onError: (err) => errors.push(err),
    });

    // First attempt fails
    await notifier.poll();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);

    // Unacknowledged cursor remains in feed
    fail = false;
    await notifier.poll();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // Third poll does not send again
    await notifier.poll();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not redeliver already acknowledged completions across notifier restarts", async () => {
    const { root, store } = await fixture();
    await store.writeCompletion(makeCompletion("worker-persist", 1));

    const sent1: any[] = [];
    const notifier1 = new CompletionNotifier(
      new Manager({ store: new ProtocolStore(root) }),
      { sendMessage: (msg: any) => sent1.push(msg) } as any,
    );
    await notifier1.poll();
    expect(sent1).toHaveLength(1);
    notifier1.dispose();

    // Reconnect new notifier to the same store (extension restart simulation)
    const sent2: any[] = [];
    const notifier2 = new CompletionNotifier(
      new Manager({ store: new ProtocolStore(root) }),
      { sendMessage: (msg: any) => sent2.push(msg) } as any,
    );
    await notifier2.poll();
    expect(sent2).toHaveLength(0);
    notifier2.dispose();
  });

  it("schedules periodic polling and cleans up timer on dispose", async () => {
    vi.useFakeTimers();
    let entries = [
      {
        cursor: 1,
        version: 1 as const,
        completion: makeCompletion("timed-worker", 1),
      },
    ];
    let queryCallCount = 0;
    const manager = {
      completions: vi.fn(async () => {
        queryCallCount++;
        return queryCallCount === 1 ? [] : entries;
      }),
      ackCompletion: vi.fn(async () => {}),
    };
    const sendMessage = vi.fn();

    const notifier = new CompletionNotifier(
      manager as any,
      { sendMessage } as any,
      {
        intervalMs: 100,
      },
    );
    await notifier.start();
    expect(sendMessage).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(manager.ackCompletion).toHaveBeenCalledWith("pi-extension", 1);

    notifier.dispose();

    entries = [
      {
        cursor: 2,
        version: 1 as const,
        completion: makeCompletion("timed-worker", 2),
      },
    ];
    await vi.advanceTimersByTimeAsync(300);
    // After dispose, no further polls occur
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
