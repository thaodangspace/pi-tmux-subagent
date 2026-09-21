import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Manager } from "../../src/manager/manager.js";
import { TmuxAdapter, execFile, sessionName } from "../../src/tmux/adapter.js";
import { workerId } from "../../src/types.js";

const cleanup: { root: string; tmuxId?: string }[] = [];
const tmuxAdapter = new TmuxAdapter();

afterEach(async () => {
  for (const x of cleanup.splice(0)) {
    if (x.tmuxId) {
      await tmuxAdapter.terminate(x.tmuxId).catch(() => undefined);
    }
    await rm(x.root, { recursive: true, force: true });
  }
});

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeout = 10000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for condition");
}

describe("tmux monitor TUI", () => {
  it("displays worker identity, status, model, and structured tool activity in spawned tmux pane", async () => {
    if (!(await tmuxAdapter.available())) return;

    const root = await mkdtemp(join(tmpdir(), "pi-sa-mon-"));
    const store = new ProtocolStore(root);
    const id = workerId("monitor-worker");
    cleanup.push({ root, tmuxId: id });

    const manager = new Manager({
      store,
      runnerFile: resolve("dist/runner/main.js"),
    });

    const origCommand = process.env.PI_TMUX_RPC_COMMAND;
    const origArgs = process.env.PI_TMUX_RPC_ARGS;
    process.env.PI_TMUX_RPC_COMMAND = process.execPath;
    process.env.PI_TMUX_RPC_ARGS = JSON.stringify([
      resolve("test/fixtures/fake-rpc-child.mjs"),
    ]);

    try {
      await manager.spawn(
        {
          task: "tool_grep refreshToken",
          name: "auth-scout",
          agent: "researcher",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        },
        root,
        id,
      );

      // Verify tmux session exists
      expect(await tmuxAdapter.exists(id)).toBe(true);

      // Wait for turn 1 to settle
      await waitFor(async () => {
        const s = await manager.status(id);
        return s.status === "waiting" && s.turn >= 1 ? s : undefined;
      });

      // Capture tmux pane output
      const pane =
        (await (tmuxAdapter as any).paneTarget(id)) ?? sessionName(id);
      const captured = await waitFor(async () => {
        const res = await execFile("tmux", ["capture-pane", "-p", "-t", pane]);
        if (res.code === 0 && res.stdout.includes("auth-scout")) {
          return res.stdout;
        }
        return undefined;
      });

      // Assertions per acceptance criteria:
      // 1. Identity: shows worker name or agent
      expect(captured).toContain("auth-scout");
      expect(captured).toContain("researcher");

      // 2. Status & turn
      expect(captured).toMatch(/●|○|waiting|running/);
      expect(captured).toContain("turn 1");

      // 3. Activity: tool name and structured arguments
      expect(captured).toContain("TOOL grep");
      expect(captured).toContain("refreshToken");

      // Stop cleanly
      await manager.stop(id);
      await manager.forceTerminate(id);
    } finally {
      if (origCommand !== undefined)
        process.env.PI_TMUX_RPC_COMMAND = origCommand;
      else delete process.env.PI_TMUX_RPC_COMMAND;
      if (origArgs !== undefined) process.env.PI_TMUX_RPC_ARGS = origArgs;
      else delete process.env.PI_TMUX_RPC_ARGS;
    }
  });
});
