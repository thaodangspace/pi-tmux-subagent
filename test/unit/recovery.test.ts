import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recovery } from "../../src/manager/recovery.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";
import { workerId } from "../../src/types.js";
import type { WorkerEvent } from "../../src/protocol/types.js";
import { Runner } from "../../src/runner/runner.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  );
});

describe("recovery", () => {
  it("reconstructs history and marks stale workers orphaned", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("recover1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-recover1",
        createdAt: "2000-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "x" },
        runnerPid: 999999,
        piPid: 999998,
        heartbeatAt: "2000-01-01T00:00:00Z",
      },
      {
        version: 1,
        id,
        status: "running",
        turn: 99,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendEvent(id, { type: "rpc_started" });
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const state = await new Recovery(store, new TmuxAdapter(exec), { orphanGraceMs: 0 }).recover(id);
    expect(state).toMatchObject({
      status: "orphaned",
      turn: 0,
      lastEventSeq: 3,
    });
  });

  it("persists suspicion across parent restart before orphaning dead workers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("dead-window1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-dead-window1",
        createdAt: "2025-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "x" },
        runnerPid: 999999,
        heartbeatAt: "2025-01-01T00:00:00Z",
      },
      { version: 1, id, status: "waiting", turn: 1, lastCommandSeq: 1, lastEventSeq: 0 },
    );
    await store.appendEvent(id, { type: "rpc_started" });
    const exec = vi.fn<Executor>().mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    expect(
      (await new Recovery(store, new TmuxAdapter(exec), { orphanGraceMs: 1_000 }).recover(id)).status,
    ).toBe("waiting");
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    expect(
      (await new Recovery(store, new TmuxAdapter(exec), { orphanGraceMs: 1_000 }).recover(id)).status,
    ).toBe("orphaned");
  });

  it("does not orphan a fresh starting worker within startup grace period", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("fresh1");
    // Just created now (no runnerPid, no piPid, no heartbeatAt yet)
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-fresh1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "fresh" },
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const recovery = new Recovery(store, new TmuxAdapter(exec), {
      startupGraceMs: 15_000,
    });
    const state = await recovery.recover(id);
    expect(state.status).toBe("starting");

    // Ensure no orphaned event was written
    const events = await store.readLog(id, "events");
    expect(events.filter((e: any) => e.type === "orphaned")).toHaveLength(0);
  });

  it("orphans a starting worker once startup grace period has expired", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("stale-start1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-stale-start1",
        createdAt: "2000-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "stale" },
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const recovery = new Recovery(store, new TmuxAdapter(exec), {
      startupGraceMs: 5_000,
      orphanGraceMs: 0,
    });
    const state = await recovery.recover(id);
    expect(state.status).toBe("orphaned");
  });

  it("recovers from one transient tmux failure without orphaning", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("transient1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-transient1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "x" },
        runnerPid: process.pid,
        piPid: process.pid,
        heartbeatAt: new Date().toISOString(),
      },
      { version: 1, id, status: "waiting", turn: 1, lastCommandSeq: 1, lastEventSeq: 0 },
    );
    await store.appendEvent(id, { type: "rpc_started" });
    const exec = vi
      .fn<Executor>()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const recovery = new Recovery(store, new TmuxAdapter(exec), {
      orphanGraceMs: 10_000,
    });

    expect((await recovery.recover(id)).status).toBe("waiting");
    expect((await recovery.recover(id)).status).toBe("waiting");
    const events = await store.readLog<any>(id, "events");
    expect(events.map((event) => event.type)).toContain("liveness_suspected");
    expect(events.map((event) => event.type)).toContain("liveness_recovered");
    expect(events.map((event) => event.type)).not.toContain("orphaned");
  });

  it("treats heartbeat and Pi PID as advisory while tmux and runner are alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("advisory1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-advisory1",
        createdAt: "2000-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "x" },
        runnerPid: process.pid,
        piPid: 999998,
        heartbeatAt: "2000-01-01T00:00:00Z",
      },
      { version: 1, id, status: "waiting", turn: 1, lastCommandSeq: 1, lastEventSeq: 0 },
    );
    await store.appendEvent(id, { type: "rpc_started" });
    const exec = vi.fn<Executor>().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    expect((await new Recovery(store, new TmuxAdapter(exec)).recover(id)).status).toBe("waiting");
  });

  it("performs liveness checks on settled waiting workers and detects dead runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("settled-dead1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-settled-dead1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "first" },
        runnerPid: 999999,
        piPid: 999998,
        heartbeatAt: "2000-01-01T00:00:00Z", // stale
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendEvent(id, { type: "rpc_started" });
    await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
    await store.appendEvent(id, { type: "agent_start" });
    await store.appendEvent(id, { type: "agent_settled" });

    // Settled worker is waiting, not terminal completed
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const recovery = new Recovery(store, new TmuxAdapter(exec), { orphanGraceMs: 0 });
    const state = await recovery.recover(id);
    // Because runner is dead and heartbeat is stale, recovery marks it orphaned
    expect(state.status).toBe("orphaned");
  });

  it("rebuilds a missing turn completion after the failed result was already written", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-terminal-reconcile-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("terminal-reconcile");
    const ownerSessionKey = "terminal-owner";
    await store.create(
      {
        version: 1,
        id,
        ownerSessionKey,
        tmuxSession: "pi-sa-terminal-reconcile",
        createdAt: "2000-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "x" },
        runnerPid: 999999,
      },
      { version: 1, id, status: "starting", turn: 0, lastCommandSeq: 0, lastEventSeq: 0 },
    );
    await store.appendEventAndProjectState(id, { type: "rpc_started" });
    await store.appendEventAndProjectState(id, { type: "command_ack", commandSeq: 1 });
    await store.appendEventAndProjectState(id, {
      type: "agent_start",
      commandSeq: 1,
      data: { turnContext: { initiatingCommandSeq: 1 } },
    });
    await store.appendEventAndProjectState(id, { type: "command_ack", commandSeq: 2 });
    await store.appendEventAndProjectState(id, { type: "command_ack", commandSeq: 3 });
    for (let index = 0; index < 25; index++) {
      await store.appendEventAndProjectState(id, { type: "message_update", data: index });
    }
    const { event: terminal } = await store.appendEventAndProjectState(id, {
      type: "orphaned",
      data: { session: false, runnerAlive: false },
    });
    await store.writeResult({
      version: 1,
      id,
      status: "failed",
      turn: 1,
      commandSeq: 1,
      resultSeq: terminal.seq,
      eventSeq: terminal.seq,
      text: "Worker process terminated unexpectedly (orphaned)",
      completedAt: terminal.at,
    });

    const tmux = new TmuxAdapter(
      vi.fn<Executor>().mockResolvedValue({ code: 1, stdout: "", stderr: "" }),
    );
    await new Recovery(store, tmux, { orphanGraceMs: 0 }).recover(id);

    const entries = await store.completions({ consumer: "audit", ownerSessionKey });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.completion).toMatchObject({
      kind: "turn",
      turn: 1,
      commandSeq: 1,
      resultSeq: terminal.seq,
      status: "failed",
    });
  });

  it("serializes concurrent recovery invocations via worker lock so single transition occurs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    const id = workerId("concurrent-rec");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-concurrent-rec",
        createdAt: "2000-01-01T00:00:00Z",
        cwd: root,
        launch: { task: "concurrent" },
        runnerPid: 999999,
        piPid: 999998,
        heartbeatAt: "2000-01-01T00:00:00Z",
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
    await store.appendEvent(id, { type: "rpc_started" });

    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const recovery1 = new Recovery(store, new TmuxAdapter(exec), { orphanGraceMs: 0 });
    const recovery2 = new Recovery(store, new TmuxAdapter(exec), { orphanGraceMs: 0 });

    const [state1, state2] = await Promise.all([
      recovery1.recover(id),
      recovery2.recover(id),
    ]);

    expect(state1.status).toBe("orphaned");
    expect(state2.status).toBe("orphaned");

    const events = await store.readLog<WorkerEvent>(id, "events");
    const orphanedEvents = events.filter((e) => e.type === "orphaned");
    expect(orphanedEvents).toHaveLength(1);
  });

  describe("state/runner turn invariant across startup recovery paths", () => {
    it("preserves turn invariant after normal restart following settled turn", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-turn-normal-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("turn-normal");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "normal" },
        },
        {
          version: 1,
          id,
          status: "waiting",
          turn: 2,
          lastCommandSeq: 2,
          lastEventSeq: 4,
        },
      );
      await store.writeResult({
        version: 1,
        id,
        turn: 2,
        commandSeq: 2,
        resultSeq: 4,
        eventSeq: 4,
        status: "completed",
        text: "turn 2 completed",
        completedAt: "2026-01-01T00:02:00Z",
      });
      await store.writeCompletion({
        version: 1,
        kind: "turn",
        id,
        turn: 2,
        commandSeq: 2,
        resultSeq: 4,
        status: "completed",
        summary: "turn 2 completed",
        hasDetails: false,
        completedAt: "2026-01-01T00:02:00Z",
      });

      const runner = new Runner(store.dir(id)) as any;
      runner.rpc = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
      const runPromise = runner.run();
      runner.stopped = true;
      if (runner.heartbeat) clearInterval(runner.heartbeat);
      await runPromise.catch(() => undefined);

      const durableState = await store.readState(id);
      expect(runner.currentTurn).toBe(2);
      expect(durableState.turn).toBe(2);
      expect(runner.currentTurn).toBe(durableState.turn);
    });

    it("preserves turn invariant after interrupted active turn", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-turn-interrupted-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("turn-interrupted");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "active crash" },
        },
        {
          version: 1,
          id,
          status: "running",
          turn: 1,
          lastCommandSeq: 1,
          lastEventSeq: 2,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "cmd 1" });
      await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
      await store.appendEvent(id, {
        type: "agent_start",
        commandSeq: 1,
        data: { turnContext: { turn: 1, initiatingCommandSeq: 1 } },
      });

      const runner = new Runner(store.dir(id)) as any;
      runner.rpc = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
      const runPromise = runner.run();
      runner.stopped = true;
      if (runner.heartbeat) clearInterval(runner.heartbeat);
      await runPromise.catch(() => undefined);

      const durableState = await store.readState(id);
      expect(runner.currentTurn).toBe(1);
      expect(durableState.turn).toBe(1);
      expect(runner.currentTurn).toBe(durableState.turn);
    });

    it("preserves turn invariant after ACKed-before-start turn", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-turn-unstarted-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("turn-unstarted");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "unstarted crash" },
        },
        {
          version: 1,
          id,
          status: "waiting",
          turn: 0,
          lastCommandSeq: 1,
          lastEventSeq: 1,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "cmd 1" });
      await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });

      const runner = new Runner(store.dir(id)) as any;
      runner.rpc = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
      const runPromise = runner.run();
      runner.stopped = true;
      if (runner.heartbeat) clearInterval(runner.heartbeat);
      await runPromise.catch(() => undefined);

      const durableState = await store.readState(id);
      expect(runner.currentTurn).toBe(1);
      expect(durableState.turn).toBe(1);
      expect(runner.currentTurn).toBe(durableState.turn);
    });

    it("preserves turn invariant after multiple recovered ACKed-before-start commands", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sa-turn-multi-"));
      roots.push(root);
      const store = new ProtocolStore(root);
      const id = workerId("turn-multi");
      await store.create(
        {
          version: 1,
          id,
          tmuxSession: `pi-sa-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
          cwd: root,
          launch: { task: "multi unstarted" },
        },
        {
          version: 1,
          id,
          status: "waiting",
          turn: 1,
          lastCommandSeq: 3,
          lastEventSeq: 4,
        },
      );
      await store.appendCommand(id, { type: "prompt", text: "cmd 1" });
      await store.appendCommand(id, { type: "send", text: "cmd 2" });
      await store.appendCommand(id, { type: "send", text: "cmd 3" });

      await store.appendEvent(id, { type: "command_ack", commandSeq: 1 });
      await store.appendEvent(id, {
        type: "agent_start",
        commandSeq: 1,
        data: { turnContext: { turn: 1, initiatingCommandSeq: 1 } },
      });
      await store.appendEvent(id, { type: "command_ack", commandSeq: 2 });
      await store.appendEvent(id, { type: "command_ack", commandSeq: 3 });

      await store.writeResult({
        version: 1,
        id,
        turn: 1,
        commandSeq: 1,
        resultSeq: 2,
        eventSeq: 2,
        status: "completed",
        text: "cmd 1 completed",
        completedAt: "2026-01-01T00:01:00Z",
      });
      await store.writeCompletion({
        version: 1,
        kind: "turn",
        id,
        turn: 1,
        commandSeq: 1,
        resultSeq: 2,
        status: "completed",
        summary: "cmd 1 completed",
        hasDetails: false,
        completedAt: "2026-01-01T00:01:00Z",
      });

      const runner = new Runner(store.dir(id)) as any;
      runner.rpc = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
      const runPromise = runner.run();
      runner.stopped = true;
      if (runner.heartbeat) clearInterval(runner.heartbeat);
      await runPromise.catch(() => undefined);

      const durableState = await store.readState(id);
      expect(runner.currentTurn).toBe(3);
      expect(durableState.turn).toBe(3);
      expect(runner.currentTurn).toBe(durableState.turn);
    });
  });
});
