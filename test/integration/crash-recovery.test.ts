import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Runner } from "../../src/runner/runner.js";
import type { WorkerResult } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pi-crash-${name}-`));
  roots.push(root);
  const store = new ProtocolStore(root);
  const id = workerId(name);
  await store.create(
    {
      version: 1,
      id,
      tmuxSession: `pi-sa-${name}`,
      createdAt: new Date().toISOString(),
      cwd: root,
      launch: { task: name },
    },
    {
      version: 1,
      id,
      status: "waiting",
      turn: 0,
      lastCommandSeq: 0,
      lastEventSeq: 0,
    },
  );
  return { root, store, id };
}

describe("crash recovery across turn boundaries", () => {
  it("boundary 1: crash after RPC accepts command before command_ack -> re-executes on restart", async () => {
    const { store, id } = await fixture("worker-b1");

    // Command was appended to commands.jsonl
    const cmd = await store.appendCommand(id, {
      type: "prompt",
      text: "execute me after crash",
    });
    expect(cmd.seq).toBe(1);

    // Runner crashed before writing command_ack and updating state.lastCommandSeq
    // So state still has lastCommandSeq = 0
    const state = await store.readState(id);
    expect(state.lastCommandSeq).toBe(0);

    // On restart, runner creates RPC and consumes commands
    const runner = new Runner(store.dir(id)) as any;
    const executedPrompts: string[] = [];
    runner.rpc = {
      prompt: vi.fn(async (text: string) => {
        executedPrompts.push(text);
      }),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      stop: vi.fn(),
    };

    // Runner starts consumption
    await runner.consume();

    // Command was re-executed and prompt was dispatched
    expect(executedPrompts).toEqual(["execute me after crash"]);
    expect(runner.lastProcessedCommandSeq).toBe(1);

    // command_ack was written
    const events = await store.readLog<any>(id, "events");
    expect(events.some((e) => e.type === "command_ack" && e.commandSeq === 1)).toBe(true);
  });

  it("boundary 2: crash after command_ack before message_end -> unfinalized turn finalized with failed result + completion", async () => {
    const { store, id } = await fixture("worker-b2");

    // Simulate state where command_ack was written and turn started (turn 1)
    await store.appendCommand(id, { type: "prompt", text: "will crash mid-turn" });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
    await store.appendEvent(id, { type: "agent_start" });
    await store.writeState({
      version: 1,
      id,
      status: "running",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 2,
    });

    // Verify no result or completion exists yet for turn 1
    expect(await store.readResult(id).catch(() => undefined)).toBeUndefined();
    expect(await store.readCompletion(id)).toBeUndefined();

    // Runner restarts and initializes (recovering unfinalized turn)
    const runner = new Runner(store.dir(id)) as any;
    runner.rpc = {
      start: vi.fn(),
      stop: vi.fn(),
      on: vi.fn(),
    };

    // Run recovery logic by starting runner (or triggering run initialization)
    // To avoid long-running loops, we spy on rpc.start and prevent full run loop if needed
    // Or we can invoke runner.run() and immediately stop it
    const runPromise = runner.run();
    runner.stopped = true;
    if (runner.heartbeat) clearInterval(runner.heartbeat);
    await runPromise.catch(() => undefined);

    // Verify unfinalized turn was recovered:
    // 1. turn_interrupted event was recorded
    const events = await store.readLog<any>(id, "events");
    expect(events.some((e) => e.type === "turn_interrupted")).toBe(true);

    // 2. Failed result was written for turn 1
    const result = await store.readResult(id);
    expect(result).toBeDefined();
    expect(result?.turn).toBe(1);
    expect(result?.status).toBe("failed");
    expect(result?.text).toContain("Turn interrupted by runner crash/restart");

    // 3. Failed completion was published for turn 1
    const completion = await store.readCompletion(id);
    expect(completion).toBeDefined();
    expect(completion?.turn).toBe(1);
    expect(completion?.status).toBe("failed");
  });

  it("boundary 3: crash after message_end before result write -> unfinalized turn finalized with failed result + completion", async () => {
    const { store, id } = await fixture("worker-b3");

    // Simulate crash after message_end: turn is 1, events contain message_end, but no result file written
    await store.appendCommand(id, { type: "prompt", text: "crash before result" });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
    await store.appendEvent(id, { type: "agent_start" });
    await store.appendEvent(id, {
      type: "assistant_delta",
      data: "output text",
    });
    await store.writeState({
      version: 1,
      id,
      status: "running",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 3,
    });

    const runner = new Runner(store.dir(id)) as any;
    runner.rpc = {
      start: vi.fn(),
      stop: vi.fn(),
      on: vi.fn(),
    };

    const runPromise = runner.run();
    runner.stopped = true;
    if (runner.heartbeat) clearInterval(runner.heartbeat);
    await runPromise.catch(() => undefined);

    // Result and completion must be finalized with failure
    const result = await store.readResult(id);
    expect(result).toMatchObject({
      turn: 1,
      status: "failed",
    });

    const completion = await store.readCompletion(id);
    expect(completion).toMatchObject({
      turn: 1,
      status: "failed",
    });
  });

  it("boundary 4: crash after result write before completion write -> missing completion published on restart", async () => {
    const { store, id } = await fixture("worker-b4");

    // Simulate crash after result write: turn 1 has a completed WorkerResult, but completion was NOT written
    await store.appendCommand(id, { type: "prompt", text: "complete then crash" });
    await store.writeState({
      version: 1,
      id,
      status: "waiting",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 4,
    });

    const validResult: WorkerResult = {
      version: 1,
      id,
      turn: 1,
      commandSeq: 1,
      resultSeq: 4,
      eventSeq: 4,
      status: "completed",
      text: "Task completed successfully before crash",
      completedAt: new Date().toISOString(),
    };
    await store.writeResult(validResult);

    // Verify completion is missing
    expect(await store.readCompletion(id)).toBeUndefined();

    // Runner restarts
    const runner = new Runner(store.dir(id)) as any;
    runner.rpc = {
      start: vi.fn(),
      stop: vi.fn(),
      on: vi.fn(),
    };

    const runPromise = runner.run();
    runner.stopped = true;
    if (runner.heartbeat) clearInterval(runner.heartbeat);
    await runPromise.catch(() => undefined);

    // Missing completion must have been published on restart
    const completion = await store.readCompletion(id);
    expect(completion).toBeDefined();
    expect(completion).toMatchObject({
      turn: 1,
      commandSeq: 1,
      resultSeq: 4,
      status: "completed",
      summary: "Task completed successfully before crash",
    });
  });
});
