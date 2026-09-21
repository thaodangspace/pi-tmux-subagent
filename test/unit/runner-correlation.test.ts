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
});
