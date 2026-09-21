import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Manager } from "../../src/manager/manager.js";
import { Runner } from "../../src/runner/runner.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sa-hung-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  const id = workerId("hung-worker");
  await store.create(
    {
      version: 1,
      id,
      tmuxSession: "pi-sa-hung",
      createdAt: new Date().toISOString(),
      cwd: root,
      launch: { task: "hung" },
      runnerPid: process.pid,
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

describe("hung worker handling", () => {
  it("transitions to unresponsive when RPC child accepts command but hangs without output, while kill remains available", async () => {
    const { store, id } = await fixture();

    // Configure runner with a short unresponsiveMs threshold (e.g. 50ms)
    const runner = new Runner(store.dir(id), {
      unresponsiveMs: 50,
    }) as any;

    let promptCalls = 0;
    let resolvePrompt: () => void;
    // Mock RPC client that accepts command but never responds (hangs)
    runner.rpc = {
      pid: 12345,
      prompt: vi.fn(() => {
        promptCalls++;
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };

    // 1. Worker receives a prompt command
    const cmd = await store.appendCommand(id, {
      type: "prompt",
      text: "do something that hangs",
    });

    // Execute the command in runner (do not await, since it hangs waiting for RPC response)
    const executePromise = runner.execute(cmd);

    // Prompt was called once
    expect(promptCalls).toBe(1);

    // Check state immediately: status is still waiting
    let state = await store.readState(id);
    expect(state.status).toBe("waiting");

    // Advance time beyond the 50ms unresponsive threshold
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Runner heartbeat/touch fires
    await runner.touch();

    // Verify worker has transitioned to unresponsive
    state = await store.readState(id);
    expect(state.status).toBe("unresponsive");

    // Verify unresponsive event was recorded with command seq
    const events = await store.readLog<any>(id, "events");
    const unrespEvent = events.find((e) => e.type === "unresponsive");
    expect(unrespEvent).toBeDefined();
    expect(unrespEvent.commandSeq).toBe(cmd.seq);

    // Verify no prompt duplication occurred (still called exactly once)
    expect(promptCalls).toBe(1);

    // 2. Supervisor forceTerminate remains available on unresponsive worker
    const tmux = {
      terminate: vi.fn(async () => {}),
    };
    const manager = new Manager({ store, tmux: tmux as any });

    const killedState = await manager.forceTerminate(id);
    expect(killedState.status).toBe("killed");
    expect(tmux.terminate).toHaveBeenCalledWith(id);

    // Verify failure result and completion were published
    const finalCompletion = await store.readCompletion(id);
    expect(finalCompletion).toBeDefined();
    expect(finalCompletion?.status).toBe("failed");
    expect(finalCompletion?.summary).toContain("Force-terminated by supervisor");

    const finalResult = await store.readResult(id);
    expect(finalResult).toBeDefined();
    expect(finalResult?.status).toBe("failed");

    resolvePrompt!();
    await executePromise.catch(() => undefined);
  });

  it("recovers to responsive when RPC child eventually emits an event", async () => {
    const { store, id } = await fixture();

    const runner = new Runner(store.dir(id), {
      unresponsiveMs: 30,
    }) as any;

    let resolvePrompt: () => void;
    runner.rpc = {
      pid: 12345,
      prompt: vi.fn(() => {
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
    };

    const cmd = await store.appendCommand(id, {
      type: "prompt",
      text: "slow query",
    });
    const executePromise = runner.execute(cmd);

    // Wait and trigger unresponsive
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runner.touch();
    let state = await store.readState(id);
    expect(state.status).toBe("unresponsive");

    // Now RPC child finally responds with agent_start
    await runner.onRpc({ type: "agent_start" });

    state = await store.readState(id);
    expect(state.status).toBe("running");

    // Check responsive event was recorded
    const events = await store.readLog<any>(id, "events");
    expect(events.some((e) => e.type === "responsive")).toBe(true);

    resolvePrompt!();
    await executePromise.catch(() => undefined);
  });

  it("transitions to unresponsive when an active turn stops emitting progress, and recovers when progress resumes", async () => {
    const { store, id } = await fixture();

    const runner = new Runner(store.dir(id), {
      unresponsiveMs: 40,
    }) as any;

    let resolvePrompt: () => void;
    runner.rpc = {
      pid: 12345,
      prompt: vi.fn(() => {
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
    };

    const cmd = await store.appendCommand(id, {
      type: "prompt",
      text: "turn that stalls mid-execution",
    });
    const executePromise = runner.execute(cmd);

    // Turn starts
    await runner.onRpc({ type: "agent_start" });
    let state = await store.readState(id);
    expect(state.status).toBe("running");

    // Wait past unresponsive threshold without any RPC activity
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.touch();

    // Verify transition to unresponsive during active turn
    state = await store.readState(id);
    expect(state.status).toBe("unresponsive");

    // Activity arrives (e.g. streaming assistant delta)
    await runner.onRpc({ type: "message_delta", delta: "still thinking" });

    // Verify recovery back to running
    state = await store.readState(id);
    expect(state.status).toBe("running");

    resolvePrompt!();
    await executePromise.catch(() => undefined);
  });
});
