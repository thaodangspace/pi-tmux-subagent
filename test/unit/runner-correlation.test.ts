import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Runner } from "../../src/runner/runner.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runner turn correlation", () => {
  it("freezes the initiating command while queued sends and steer/abort arrive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runner-correlation-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("correlation1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-correlation1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "first" },
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

    const runner = new Runner(store.dir(id)) as any;
    runner.rpc = {
      prompt: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };

    await runner.execute({ version: 1, seq: 1, at: "a", type: "prompt", text: "first" });
    await runner.onRpc({ type: "agent_start" });
    await runner.execute({ version: 1, seq: 2, at: "b", type: "send", text: "second" });
    await runner.execute({ version: 1, seq: 3, at: "c", type: "steer", text: "adjust" });
    await runner.execute({ version: 1, seq: 4, at: "d", type: "abort" });
    await runner.onRpc({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "first result" }] },
    });
    await runner.onRpc({ type: "agent_settled" });

    const firstCompletion = await store.readCompletion(id);
    expect(firstCompletion).toMatchObject({ turn: 1, commandSeq: 1 });
    expect(
      await store.readResult(id, {
        turn: 1,
        resultSeq: firstCompletion!.resultSeq,
      }),
    ).toMatchObject({ text: "first result", commandSeq: 1 });
    const related = (await store.readLog<any>(id, "events")).filter(
      (event) => event.type === "turn_command_related",
    );
    expect(related.map((event) => event.data)).toMatchObject([
      { initiatingCommandSeq: 1, relatedCommandSeq: 3, commandType: "steer" },
      { initiatingCommandSeq: 1, relatedCommandSeq: 4, commandType: "abort" },
    ]);

    await runner.onRpc({ type: "agent_start" });
    await runner.onRpc({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "second result" }] },
    });
    await runner.onRpc({ type: "agent_settled" });
    const secondCompletion = await store.readCompletion(id);
    expect(secondCompletion).toMatchObject({ turn: 2, commandSeq: 2 });
  });

  it("recovers unstarted command by identity when unrelated agent_start exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runner-correlation-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("correlation-unrelated");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: `pi-sa-${id}`,
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "first" },
      },
      {
        version: 1,
        id,
        status: "waiting",
        turn: 0,
        lastCommandSeq: 1,
        lastEventSeq: 2,
      },
    );

    // Command A (seq: 1) is ACKed
    await store.appendCommand(id, { type: "prompt", text: "command A" });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
    // An unrelated agent_start exists with no initiating command sequence
    await store.appendEvent(id, {
      type: "agent_start",
      data: { turnContext: { turn: 1, relatedCommandSeqs: [] } },
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

    // Command A must be finalized as an interrupted pre-start turn, not skipped
    const result = await store.readResult(id);
    expect(result).toBeDefined();
    expect(result?.turn).toBe(1);
    expect(result?.commandSeq).toBe(1);
    expect(result?.status).toBe("failed");
    expect(result?.text).toContain("Turn interrupted before start");

    const completion = await store.readCompletion(id);
    expect(completion).toBeDefined();
    expect(completion?.turn).toBe(1);
    expect(completion?.commandSeq).toBe(1);
    expect(completion?.status).toBe("failed");
  });

  it("uses exact set subtraction for multiple ACKed commands and explicit initiatingCommandSeq", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runner-correlation-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("correlation-subset");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: `pi-sa-${id}`,
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "cmd1" },
      },
      {
        version: 1,
        id,
        status: "waiting",
        turn: 2,
        lastCommandSeq: 3,
        lastEventSeq: 6,
      },
    );

    // Commands 1, 2, 3 are all ACKed
    await store.appendCommand(id, { type: "prompt", text: "cmd 1" });
    await store.appendCommand(id, { type: "send", text: "cmd 2" });
    await store.appendCommand(id, { type: "send", text: "cmd 3" });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 2 });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 3 });

    // agent_start for command 1
    await store.appendEvent(id, {
      type: "agent_start",
      commandSeq: 1,
      data: { turnContext: { turn: 1, initiatingCommandSeq: 1 } },
    });
    // agent_start for command 3 (out of order or skipping 2)
    await store.appendEvent(id, {
      type: "agent_start",
      commandSeq: 3,
      data: { turnContext: { turn: 2, initiatingCommandSeq: 3 } },
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

    // Only Command 2 (unstarted) should be finalized as recovered turn
    const result = await store.readResult(id);
    expect(result).toBeDefined();
    expect(result?.commandSeq).toBe(2);
    expect(result?.turn).toBe(3);
    expect(result?.status).toBe("failed");
    expect(result?.text).toContain("Turn interrupted before start");

    const completion = await store.readCompletion(id);
    expect(completion).toBeDefined();
    expect(completion?.commandSeq).toBe(2);
    expect(completion?.turn).toBe(3);
    expect(completion?.status).toBe("failed");
  });
});
