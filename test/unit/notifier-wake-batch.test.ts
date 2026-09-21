import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionNotifier } from "../../src/extension/completion-notifier.js";
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
  const root = await mkdtemp(join(tmpdir(), "pi-sa-batch-"));
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

describe("notifier wake-up batching policy", () => {
  it("delivers 3 rapid completions with only 1 triggerTurn: true on the last message", async () => {
    const { store, manager } = await fixture();
    const c1 = makeCompletion("worker-1", 1, "completed", "Job 1 done");
    const c2 = makeCompletion("worker-2", 1, "completed", "Job 2 done");
    const c3 = makeCompletion("worker-3", 1, "completed", "Job 3 done");

    await store.writeCompletion(c1, "parent-session-1");
    await store.writeCompletion(c2, "parent-session-1");
    await store.writeCompletion(c3, "parent-session-1");

    const sent: { message: any; options: any }[] = [];
    const pi = {
      sendMessage: vi.fn(async (message: any, options: any) => {
        sent.push({ message, options });
      }),
    };

    const notifier = new CompletionNotifier(manager, pi as any, {
      ownerSessionKey: "parent-session-1",
      deliveryOptions: {
        deliverAs: "followUp",
      },
    });

    await notifier.poll();

    expect(sent).toHaveLength(3);
    // All 3 completions delivered as followUp
    expect(sent[0]!.options.deliverAs).toBe("followUp");
    expect(sent[1]!.options.deliverAs).toBe("followUp");
    expect(sent[2]!.options.deliverAs).toBe("followUp");

    // Only the last item in the batch triggers a parent turn
    expect(sent[0]!.options.triggerTurn).toBe(false);
    expect(sent[1]!.options.triggerTurn).toBe(false);
    expect(sent[2]!.options.triggerTurn).toBe(true);

    // Number of turns triggered across this batch is exactly 1
    const turnCount = sent.filter((s) => s.options.triggerTurn === true).length;
    expect(turnCount).toBe(1);
  });

  it("respects explicit triggerTurn: false override for all completions in a batch", async () => {
    const { store, manager } = await fixture();
    const c1 = makeCompletion("worker-1", 1);
    const c2 = makeCompletion("worker-2", 1);

    await store.writeCompletion(c1, "parent-session-2");
    await store.writeCompletion(c2, "parent-session-2");

    const sent: { message: any; options: any }[] = [];
    const pi = {
      sendMessage: vi.fn(async (message: any, options: any) => {
        sent.push({ message, options });
      }),
    };

    const notifier = new CompletionNotifier(manager, pi as any, {
      ownerSessionKey: "parent-session-2",
      deliveryOptions: {
        triggerTurn: false,
      },
    });

    await notifier.poll();

    expect(sent).toHaveLength(2);
    expect(sent[0]!.options.triggerTurn).toBe(false);
    expect(sent[1]!.options.triggerTurn).toBe(false);
  });

  it("handles multiple batches over time triggering at most 1 turn per poll", async () => {
    const { store, manager } = await fixture();
    const c1 = makeCompletion("worker-1", 1);
    const c2 = makeCompletion("worker-2", 1);
    await store.writeCompletion(c1, "session-stream");
    await store.writeCompletion(c2, "session-stream");

    const sent: { message: any; options: any }[] = [];
    const pi = {
      sendMessage: vi.fn(async (message: any, options: any) => {
        sent.push({ message, options });
      }),
    };

    const notifier = new CompletionNotifier(manager, pi as any, {
      ownerSessionKey: "session-stream",
    });

    // Batch 1: 2 completions
    await notifier.poll();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.options.triggerTurn).toBe(false);
    expect(sent[1]!.options.triggerTurn).toBe(true);

    // Later: 1 more completion arrives
    const c3 = makeCompletion("worker-3", 1);
    await store.writeCompletion(c3, "session-stream");

    // Batch 2: 1 completion
    await notifier.poll();
    expect(sent).toHaveLength(3);
    expect(sent[2]!.options.triggerTurn).toBe(true);
  });
});
