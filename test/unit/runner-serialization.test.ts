import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Runner } from "../../src/runner/runner.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runner RPC event serialization and failure boundary", () => {
  it("serializes concurrent RPC events so turn 2 cannot corrupt turn 1 settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runner-serial-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("serial1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-serial1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "turn1" },
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
      notify: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      stop: vi.fn(),
    };

    // Queue command 1 and start turn 1
    await runner.execute({
      version: 1,
      seq: 1,
      at: "2026-01-01T00:00:00Z",
      type: "prompt",
      text: "turn1",
    });

    // Queue command 2 in advance
    await runner.execute({
      version: 1,
      seq: 2,
      at: "2026-01-01T00:00:01Z",
      type: "send",
      text: "turn2",
    });

    // Simulate rapid chunk containing turn 1 end, settled, and turn 2 start
    const events = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer 1" }],
        },
      },
      { type: "agent_settled" },
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer 2" }],
        },
      },
      { type: "agent_settled" },
    ];

    // Feed events concurrently through rpc.on("event") queue
    await Promise.all(
      events.map((event) => {
        runner.rpcEventQueue = runner.rpcEventQueue.then(() =>
          runner.onRpc(event),
        );
        return runner.rpcEventQueue;
      }),
    );

    const resultFiles = await store.readResult(id);
    const completion = await store.readCompletion(id);
    expect(resultFiles).toMatchObject({
      turn: 2,
      commandSeq: 2,
      text: "Answer 2",
      status: "completed",
    });
    expect(completion).toMatchObject({
      turn: 2,
      commandSeq: 2,
      status: "completed",
    });
  });

  it("routes fatal RPC rejection through idempotent durable failure handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runner-fail-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("fail1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-fail1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "fail-task" },
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
      prompt: vi.fn(async () => {
        throw new Error("RPC rejection: model capacity exceeded");
      }),
      notify: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      stop: vi.fn(),
    };

    // Trigger failOnce from rejection, then immediately fire another exit signal
    await runner
      .execute({
        version: 1,
        seq: 1,
        at: "2026-01-01T00:00:00Z",
        type: "prompt",
        text: "fail-task",
      })
      .catch((err: any) => runner.failOnce(err));

    // Secondary error event or exit signal
    await runner.failOnce(new Error("Secondary exit signal"));

    const state = await store.readState(id);
    expect(state.status).toBe("failed");
    expect(state.error).toContain("model capacity exceeded");

    const result = await store.readResult(id);
    expect(result).toMatchObject({
      status: "failed",
      turn: 0,
      commandSeq: 1,
      text: "RPC rejection: model capacity exceeded",
    });

    const completion = await store.readCompletion(id);
    expect(completion).toMatchObject({
      status: "failed",
      turn: 0,
      commandSeq: 1,
    });

    // Verify only one failure event was recorded
    const events = await store.readLog<any>(id, "events");
    const failureEvents = events.filter((e) => e.type === "failed");
    expect(failureEvents).toHaveLength(1);
  });
});
