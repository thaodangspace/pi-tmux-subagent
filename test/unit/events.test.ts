import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { completedNotification } from "../../src/protocol/completion.js";
import type { WorkerResult } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];

async function setupWorker(workerName = "worker1") {
  const root = await mkdtemp(join(tmpdir(), "pi-events-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  const id = workerId(workerName);
  await store.create(
    {
      version: 1,
      id,
      tmuxSession: `pi-sa-${workerName}`,
      createdAt: new Date().toISOString(),
      cwd: root,
      launch: { task: "test task" },
      workspace: { mode: "current", root },
    },
    {
      version: 1,
      id,
      status: "running",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 0,
    },
  );
  const manager = new Manager({ store });
  return { root, store, manager, id };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  );
});

describe("lazy full-result retrieval and correlation", () => {
  it("correlates full result identifiers with completion notification", async () => {
    const { store, manager, id, root } = await setupWorker();

    const result: WorkerResult = {
      version: 1,
      id,
      turn: 1,
      commandSeq: 1,
      text: "Full detailed analysis of the repository structure and authentication flow.",
      completedAt: new Date().toISOString(),
      resultSeq: 42,
      eventSeq: 42,
      workspace: {
        mode: "current",
        root,
      },
    };

    await store.writeResult(result);
    const completion = completedNotification(result);
    await store.writeCompletion(completion);

    // Fetch full result via manager.getResult
    const fullResult = await manager.getResult(id);

    // Verify correlation between completion notification and full result
    expect(fullResult.id).toBe(completion.id);
    expect(fullResult.turn).toBe(completion.turn);
    expect(fullResult.commandSeq).toBe(completion.commandSeq);
    expect(fullResult.resultSeq).toBe(completion.resultSeq);
    expect(fullResult.text).toBe(result.text);
    expect(fullResult.workspace).toEqual(result.workspace);
    expect(fullResult.completedAt).toBe(result.completedAt);
  });

  it("throws clear error when worker does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-events-"));
    roots.push(root);
    const manager = new Manager({ store: new ProtocolStore(root) });

    await expect(manager.getResult("nonexistent")).rejects.toMatchObject({
      code: "WORKER_NOT_FOUND",
      message: expect.stringContaining("Worker not found: nonexistent"),
    });
  });

  it("throws clear error when worker exists but result is not ready", async () => {
    const { manager, id } = await setupWorker();

    await expect(manager.getResult(id)).rejects.toMatchObject({
      code: "RESULT_NOT_FOUND",
      message: expect.stringContaining(`No result available for worker: ${id}`),
    });
  });
});

describe("bounded event-history retrieval", () => {
  it("returns bounded ordered slice and supports continuation with nextSeq", async () => {
    const { store, manager, id } = await setupWorker();

    // Populate 7 events
    for (let i = 1; i <= 7; i++) {
      await store.appendEvent(id, {
        type: "agent_event",
        data: { step: i, detail: `detail-${i}` },
      });
    }

    // Page 1: fromSeq 1, limit 3
    const page1 = await manager.events(id, { fromSeq: 1, limit: 3 });
    expect(page1.version).toBe(1);
    expect(page1.id).toBe(id);
    expect(page1.fromSeq).toBe(1);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextSeq).toBe(4);

    // Page 2: continue from page1.nextSeq with limit 3
    const page2 = await manager.events(id, {
      fromSeq: page1.nextSeq,
      limit: 3,
    });
    expect(page2.fromSeq).toBe(4);
    expect(page2.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(page2.hasMore).toBe(true);
    expect(page2.nextSeq).toBe(7);

    // Page 3: continue from page2.nextSeq with limit 3
    const page3 = await manager.events(id, {
      fromSeq: page2.nextSeq,
      limit: 3,
    });
    expect(page3.fromSeq).toBe(7);
    expect(page3.events.map((e) => e.seq)).toEqual([7]);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextSeq).toBeUndefined();

    // Past the end
    const page4 = await manager.events(id, { fromSeq: 8, limit: 3 });
    expect(page4.fromSeq).toBe(8);
    expect(page4.events).toEqual([]);
    expect(page4.hasMore).toBe(false);
    expect(page4.nextSeq).toBeUndefined();
  });

  it("enforces default limit and response cap on large event histories", async () => {
    const { store, manager, id } = await setupWorker();

    // Write 120 events
    for (let i = 1; i <= 120; i++) {
      await store.appendEvent(id, {
        type: "step",
        data: { index: i },
      });
    }

    // Default limit (50) is applied when no limit is given
    const defaultPage = await manager.events(id);
    expect(defaultPage.events).toHaveLength(50);
    expect(defaultPage.events[0]?.seq).toBe(1);
    expect(defaultPage.events[49]?.seq).toBe(50);
    expect(defaultPage.hasMore).toBe(true);
    expect(defaultPage.nextSeq).toBe(51);

    // Requesting limit > maxEventLimit (100) is clamped to maxEventLimit
    const clampedPage = await manager.events(id, { limit: 500 });
    expect(clampedPage.events).toHaveLength(100);
    expect(clampedPage.hasMore).toBe(true);
    expect(clampedPage.nextSeq).toBe(101);
  });

  it("respects byte budget cap to prevent overflowing tool response limits", async () => {
    const { store, id } = await setupWorker();
    const manager = new Manager({
      store,
      maxEventBytes: 1_000, // custom low byte cap for testing
    });

    // Write events with large payloads (~400 bytes each)
    for (let i = 1; i <= 5; i++) {
      await store.appendEvent(id, {
        type: "large_step",
        data: "x".repeat(350),
      });
    }

    const page = await manager.events(id, { limit: 10 });
    // First 2 events fit in 1,000 bytes, 3rd exceeds cap
    expect(page.events.length).toBeLessThan(5);
    expect(page.hasMore).toBe(true);
    expect(page.nextSeq).toBe(page.events.length + 1);
  });

  it("throws clear error on nonexistent worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-events-"));
    roots.push(root);
    const manager = new Manager({ store: new ProtocolStore(root) });

    await expect(manager.events("missing")).rejects.toMatchObject({
      code: "WORKER_NOT_FOUND",
      message: expect.stringContaining("Worker not found: missing"),
    });
  });

  it("throws clear error on invalid sequence arguments", async () => {
    const { manager, id } = await setupWorker();

    await expect(manager.events(id, { fromSeq: 0 })).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
      message: expect.stringContaining("Invalid fromSeq: 0"),
    });

    await expect(manager.events(id, { fromSeq: -10 })).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
    });

    await expect(manager.events(id, { fromSeq: 1.5 })).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
    });

    await expect(manager.events(id, { fromSeq: NaN })).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
    });
  });

  it("throws clear error on invalid limit arguments", async () => {
    const { manager, id } = await setupWorker();

    await expect(manager.events(id, { limit: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("Invalid limit: 0"),
    });

    await expect(manager.events(id, { limit: -1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    await expect(manager.events(id, { limit: 2.5 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});
