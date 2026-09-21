import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recovery } from "../../src/manager/recovery.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";
import { workerId } from "../../src/types.js";
import type { WorkerEvent } from "../../src/protocol/types.js";

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
});
