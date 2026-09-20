import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))));

describe("manager command delivery", () => {
  it("enqueues ordered control commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-")); roots.push(root);
    const exec = vi.fn<Executor>().mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({ store: new ProtocolStore(root), tmux: new TmuxAdapter(exec), runnerFile: process.execPath });
    await manager.spawn({ task: "first" }, root, "worker1");
    await manager.send("worker1", "second"); await manager.steer("worker1", "third"); await manager.abort("worker1");
    const commands = await manager.store.readLog("worker1", "commands");
    expect(commands.map((x: any) => [x.seq, x.type])).toEqual([[1,"prompt"],[2,"send"],[3,"steer"],[4,"abort"]]);
  });

  it("enforces recursive spawning depth limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-")); roots.push(root);
    const exec = vi.fn<Executor>().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({ store: new ProtocolStore(root), tmux: new TmuxAdapter(exec), runnerFile: process.execPath });

    // depth: 1, maxDepth: 1 -> limit reached!
    await expect(manager.spawn({ task: "child", depth: 1, maxDepth: 1 }, root, "deep1")).rejects.toThrow(/Spawning depth limit reached/);
  });

  it("propagates incremented depth to child metadata and tmux environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-")); roots.push(root);
    const exec = vi.fn<Executor>().mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const tmux = new TmuxAdapter(exec);
    const createSpy = vi.spyOn(tmux, "create");
    const manager = new Manager({ store: new ProtocolStore(root), tmux, runnerFile: process.execPath });

    await manager.spawn({ task: "parent", depth: 0, maxDepth: 2 }, root, "parent1");
    const meta = await manager.store.readMeta("parent1");
    expect(meta.launch.depth).toBe(0);
    expect(meta.launch.maxDepth).toBe(2);

    // Verify child env passed to tmux.create
    expect(createSpy).toHaveBeenCalledWith(
      "parent1",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      { PI_TMUX_DEPTH: "1", PI_TMUX_MAX_DEPTH: "2" },
    );
  });

  it("calling status immediately after spawn returns starting and does not orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-")); roots.push(root);
    const exec = vi.fn<Executor>().mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({ store: new ProtocolStore(root), tmux: new TmuxAdapter(exec), runnerFile: process.execPath, startupGraceMs: 15_000 });

    await manager.spawn({ task: "fresh" }, root, "fresh-worker");
    const state = await manager.status("fresh-worker");
    expect(state.status).toBe("starting");

    const events = await manager.store.readLog("fresh-worker", "events");
    expect(events.some((e: any) => e.type === "orphaned")).toBe(false);
  });
});
