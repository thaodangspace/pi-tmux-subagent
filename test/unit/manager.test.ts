import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";
import { SubagentError, workerId } from "../../src/types.js";
import type { WorkerEvent } from "../../src/protocol/types.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  ),
);

describe("manager command delivery", () => {
  it("enqueues ordered control commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const exec = vi
      .fn<Executor>()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({
      store: new ProtocolStore(root),
      tmux: new TmuxAdapter(exec),
      runnerFile: process.execPath,
    });
    await manager.spawn({ task: "first" }, root, "worker1");
    await manager.send("worker1", "second");
    await manager.steer("worker1", "third");
    await manager.abort("worker1");
    const commands = await manager.store.readLog("worker1", "commands");
    expect(commands.map((x: any) => [x.seq, x.type])).toEqual([
      [1, "prompt"],
      [2, "send"],
      [3, "steer"],
      [4, "abort"],
    ]);
  });

  it("force-terminates hung workers durably and idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = "hung-worker" as any;
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-hung-worker",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "hang" },
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
    const terminate = vi.fn(async () => {});
    const manager = new Manager({ store, tmux: { terminate } as any });

    expect(await manager.forceTerminate(id)).toMatchObject({ status: "killed" });
    expect(await manager.forceTerminate(id)).toMatchObject({ status: "killed" });
    expect(terminate).toHaveBeenCalledTimes(2);
    const events = await store.readLog<any>(id, "events");
    expect(events.filter((event) => event.type === "killed")).toHaveLength(1);
  });

  it("cleans managed worktrees before delete and preserves dirty metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = "worktree-worker" as any;
    const workspace = {
      mode: "worktree" as const,
      root,
      branch: "pi-sa/worktree-worker",
      worktree: join(root, ".pi/worktrees/worktree-worker"),
    };
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-worktree-worker",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: workspace.worktree,
        launch: { task: "done", workspace: "worktree" },
        workspace,
      },
      {
        version: 1,
        id,
        status: "stopped",
        turn: 1,
        lastCommandSeq: 2,
        lastEventSeq: 2,
      },
    );
    await store.appendEvent(id, { type: "stopped" });
    const cleanup = vi.fn(async (workspaceValue: unknown): Promise<void> => {
      void workspaceValue;
      throw Object.assign(new Error("Refusing to remove a dirty worktree"), {
        code: "DIRTY_WORKTREE",
      });
    });
    const manager = new Manager({
      store,
      tmux: { exists: vi.fn(async () => false), terminate: vi.fn(async () => {}) } as any,
      worktree: { cleanup } as any,
    });

    await expect(manager.delete(id)).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(await store.readMeta(id)).toMatchObject({ workspace });
    expect(cleanup).toHaveBeenCalledWith(workspace);

    cleanup.mockResolvedValueOnce(undefined);
    await manager.delete(id);
    await expect(store.readMeta(id)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces recursive spawning depth limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({
      store: new ProtocolStore(root),
      tmux: new TmuxAdapter(exec),
      runnerFile: process.execPath,
    });

    // depth: 1, maxDepth: 1 -> limit reached!
    await expect(
      manager.spawn({ task: "child", depth: 1, maxDepth: 1 }, root, "deep1"),
    ).rejects.toThrow(/Spawning depth limit reached/);
  });

  it("propagates incremented depth to child metadata and tmux environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const exec = vi
      .fn<Executor>()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const tmux = new TmuxAdapter(exec);
    const createSpy = vi.spyOn(tmux, "create");
    const manager = new Manager({
      store: new ProtocolStore(root),
      tmux,
      runnerFile: process.execPath,
    });

    await manager.spawn(
      { task: "parent", depth: 0, maxDepth: 2 },
      root,
      "parent1",
    );
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
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const exec = vi
      .fn<Executor>()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({
      store: new ProtocolStore(root),
      tmux: new TmuxAdapter(exec),
      runnerFile: process.execPath,
      startupGraceMs: 15_000,
    });

    await manager.spawn({ task: "fresh" }, root, "fresh-worker");
    const state = await manager.status("fresh-worker");
    expect(state.status).toBe("starting");

    const events = await manager.store.readLog("fresh-worker", "events");
    expect(events.some((e: any) => e.type === "orphaned")).toBe(false);
  });

  it.each([
    "failed",
    "killed",
    "orphaned",
    "completed",
  ] as const)("rejects send, steer, abort, and stop for terminal state '%s'", async (status) => {
    const root = await mkdtemp(join(tmpdir(), `pi-sa-term-${status}-`));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId(`term-${status}`);
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: `pi-sa-${id}`,
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "terminal test" },
      },
      {
        version: 1,
        id,
        status,
        turn: 1,
        lastCommandSeq: 1,
        lastEventSeq: 1,
      },
    );
    await store.appendCommand(id, { type: "prompt", text: "initial" });

    const manager = new Manager({ store, tmux: { exists: vi.fn(async () => false) } as any });

    // Assert send is rejected and appends no new command
    await expect(manager.send(id, "late send")).rejects.toThrow(SubagentError);
    await expect(manager.send(id, "late send")).rejects.toMatchObject({ code: "WORKER_TERMINAL" });

    // Assert steer is rejected and appends no new command
    await expect(manager.steer(id, "late steer")).rejects.toThrow(SubagentError);
    await expect(manager.steer(id, "late steer")).rejects.toMatchObject({ code: "WORKER_TERMINAL" });

    // Assert abort is rejected and appends no new command
    await expect(manager.abort(id)).rejects.toThrow(SubagentError);
    await expect(manager.abort(id)).rejects.toMatchObject({ code: "WORKER_TERMINAL" });

    // Assert stop is rejected and appends no new command
    await expect(manager.stop(id)).rejects.toThrow(SubagentError);
    await expect(manager.stop(id)).rejects.toMatchObject({ code: "WORKER_TERMINAL" });

    const commands = await store.readLog(id, "commands");
    expect(commands).toHaveLength(1);
    expect((commands[0] as any).text).toBe("initial");
  });

  it("stopped worker rejects send, steer, abort but stop is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-stopped-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("term-stopped");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: `pi-sa-${id}`,
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "stopped test" },
      },
      {
        version: 1,
        id,
        status: "stopped",
        turn: 1,
        lastCommandSeq: 2,
        lastEventSeq: 2,
      },
    );
    await store.appendCommand(id, { type: "prompt", text: "initial" });
    await store.appendCommand(id, { type: "stop" });

    const manager = new Manager({ store, tmux: { exists: vi.fn(async () => false) } as any });

    await expect(manager.send(id, "late send")).rejects.toMatchObject({ code: "WORKER_TERMINAL" });
    await expect(manager.steer(id, "late steer")).rejects.toMatchObject({ code: "WORKER_TERMINAL" });
    await expect(manager.abort(id)).rejects.toMatchObject({ code: "WORKER_TERMINAL" });

    // Stop on an already stopped worker succeeds idempotently and returns prior stop seq
    const stopSeq = await manager.stop(id);
    expect(stopSeq).toBe(2);

    // Assert no new command was appended
    const commands = await store.readLog(id, "commands");
    expect(commands).toHaveLength(2);
  });

  describe("stop idempotency semantics", () => {
    it("deduplicates pending stop command when another stop is already pending", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-stop-pending-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("stop-pending");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "stop pending test" },
        },
        {
          version: 1,
          id,
          status: "running",
          turn: 1,
          lastCommandSeq: 1,
          lastEventSeq: 1,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "initial" });

      const manager = new Manager({ store, tmux: { exists: vi.fn(async () => true) } as any });

      const firstStop = await manager.stop(id);
      expect(firstStop).toBe(2);

      // Second stop while seq 2 is still pending (> lastCommandSeq=1)
      const secondStop = await manager.stop(id);
      expect(secondStop).toBe(2);

      const commands = await store.readLog(id, "commands");
      expect(commands).toHaveLength(2);
    });

    it.each(["killed", "failed", "orphaned"] as const)(
      "rejects stop when worker is in terminal status '%s'",
      async (status) => {
        const root = await mkdtemp(join(tmpdir(), `pi-sa-stop-term-${status}-`));
        roots.push(root);
        const store = new ProtocolStore(root);
        const id = workerId(`stop-term-${status}`);
        await store.create(
          {
            version: 1,
            id,
            tmuxSession: `pi-sa-${id}`,
            createdAt: "2026-01-01T00:00:00Z",
            cwd: root,
            launch: { task: "terminal stop test" },
          },
          {
            version: 1,
            id,
            status,
            turn: 1,
            lastCommandSeq: 1,
            lastEventSeq: 1,
          },
        );

        const manager = new Manager({ store, tmux: { exists: vi.fn(async () => false) } as any });
        await expect(manager.stop(id)).rejects.toMatchObject({
          code: "WORKER_TERMINAL",
        });
      },
    );
  });

  describe("accepted-command terminal resolution (Finding 1)", () => {
    it("interleaving 1: send wins lock first -> forceTerminate durably cancels accepted command", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-order1-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("order1-worker");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "order1" },
          runnerPid: process.pid,
        },
        {
          version: 1,
          id,
          status: "waiting",
          turn: 1,
          lastCommandSeq: 1,
          lastEventSeq: 1,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "initial" });
      await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });

      const manager = new Manager({
        store,
        tmux: { terminate: vi.fn(async () => {}), exists: vi.fn(async () => true) } as any,
      });

      // Send wins first
      const sendSeq = await manager.send(id, "late command");
      expect(sendSeq).toBe(2);

      // forceTerminate runs after send
      const killedState = await manager.forceTerminate(id);
      expect(killedState.status).toBe("killed");
      expect(killedState.lastCommandSeq).toBe(2);

      // Command exists in commands.jsonl
      const commands = await store.readLog(id, "commands");
      expect(commands).toHaveLength(2);
      expect((commands[1] as any).text).toBe("late command");

      // Command has durable terminal resolution event in events.jsonl
      const events = await store.readLog<WorkerEvent>(id, "events");
      const cancelledEvent = events.find(
        (e) => e.type === "command_cancelled" && e.commandSeq === 2,
      );
      expect(cancelledEvent).toBeDefined();
      expect(cancelledEvent?.data).toMatchObject({
        reason: "Force-terminated by supervisor",
        terminalStatus: "killed",
      });

      // No accepted command remains unresolved/pending
      const finalState = await manager.status(id);
      expect(finalState.lastCommandSeq).toBeGreaterThanOrEqual(sendSeq);
    });

    it("interleaving 2: forceTerminate wins lock first -> send rejects with WORKER_TERMINAL and appends nothing", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-order2-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("order2-worker");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "order2" },
          runnerPid: process.pid,
        },
        {
          version: 1,
          id,
          status: "waiting",
          turn: 1,
          lastCommandSeq: 1,
          lastEventSeq: 1,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "initial" });
      await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });

      const manager = new Manager({
        store,
        tmux: { terminate: vi.fn(async () => {}), exists: vi.fn(async () => true) } as any,
      });

      // forceTerminate wins first
      const killedState = await manager.forceTerminate(id);
      expect(killedState.status).toBe("killed");

      // send runs after forceTerminate
      await expect(manager.send(id, "late command")).rejects.toMatchObject({
        code: "WORKER_TERMINAL",
      });

      // No command was appended
      const commands = await store.readLog(id, "commands");
      expect(commands).toHaveLength(1);
    });

    it("concurrency race test: concurrent send and forceTerminate leaves no stranded command", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-race-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("race-worker");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "race" },
          runnerPid: process.pid,
        },
        {
          version: 1,
          id,
          status: "waiting",
          turn: 1,
          lastCommandSeq: 1,
          lastEventSeq: 0,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "initial" });

      const terminate = vi.fn(async () => {});
      const manager = new Manager({
        store,
        tmux: { terminate, exists: vi.fn(async () => true) } as any,
      });

      const [termResult, sendResult] = await Promise.allSettled([
        manager.forceTerminate(id),
        manager.send(id, "late command"),
      ]);

      expect(termResult.status).toBe("fulfilled");
      const finalState = await manager.status(id);
      expect(finalState.status).toBe("killed");

      const commands = await store.readLog(id, "commands");
      const events = await store.readLog(id, "events");

      if (sendResult.status === "rejected") {
        expect((sendResult.reason as any).code).toBe("WORKER_TERMINAL");
        expect(commands.map((c: any) => c.text)).not.toContain("late command");
      } else {
        // Send won the lock: must be durably resolved with command_cancelled
        expect(commands.map((c: any) => c.text)).toContain("late command");
        const cancelled = events.find(
          (e: any) => e.type === "command_cancelled" && e.commandSeq === sendResult.value,
        );
        expect(cancelled).toBeDefined();
        expect(finalState.lastCommandSeq).toBeGreaterThanOrEqual(sendResult.value);
      }

      await expect(manager.send(id, "after killed")).rejects.toMatchObject({
        code: "WORKER_TERMINAL",
      });
      const finalCommands = await store.readLog(id, "commands");
      expect(finalCommands.map((c: any) => c.text)).not.toContain("after killed");
    });
  });
});
