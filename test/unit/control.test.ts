import { describe, expect, it, vi } from "vitest";
import { openSubagentsControl } from "../../src/extension/control.js";
import { workerId } from "../../src/types.js";

function setup(action: string, message = "do it") {
  const state = {
    version: 1 as const,
    id: workerId("worker-1"),
    status: "waiting" as const,
    turn: 1,
    lastCommandSeq: 1,
    lastEventSeq: 1,
  };
  const meta = {
    version: 1 as const,
    id: workerId("worker-1"),
    tmuxSession: "pi-sa-worker-1",
    createdAt: "2026-01-01T00:00:00Z",
    cwd: "/tmp/project",
    launch: { task: "task", name: "worker" },
  };
  const manager = {
    list: vi.fn(async () => [state]),
    status: vi.fn(async () => state),
    result: vi.fn(async () => undefined),
    send: vi.fn(async () => 2),
    steer: vi.fn(async () => 2),
    stop: vi.fn(async () => 2),
    forceTerminate: vi.fn(async () => ({ ...state, status: "killed" as const })),
    delete: vi.fn(async () => undefined),
    store: {
      readMeta: vi.fn(async () => meta),
      readLogTail: vi.fn(async () => []),
      readResult: vi.fn(async () => undefined),
    },
  };
  const select = vi
    .fn()
    .mockResolvedValueOnce("worker  waiting  turn 1")
    .mockResolvedValueOnce(action);
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      select,
      input: vi.fn(async () => message),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    },
  };
  return { manager, ctx };
}

describe("subagent controls", () => {
  it.each([
    ["Send follow-up", "send"],
    ["Steer", "steer"],
  ] as const)("dispatches %s through Manager", async (action, method) => {
    const { manager, ctx } = setup(action);
    await openSubagentsControl(manager as any, ctx as any);
    expect(manager[method]).toHaveBeenCalledWith("worker-1", "do it");
  });
  it("requires confirmation and queues a graceful stop", async () => {
    const { manager, ctx } = setup("Stop");
    await openSubagentsControl(manager as any, ctx as any);
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledWith("worker-1");
  });
  it("requires confirmation and force-terminates a hung worker", async () => {
    const { manager, ctx } = setup("Force kill");
    await openSubagentsControl(manager as any, ctx as any);
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(manager.forceTerminate).toHaveBeenCalledWith("worker-1");
  });
  it("requires confirmation and deletes stored worker data", async () => {
    const { manager, ctx } = setup("Delete");
    await openSubagentsControl(manager as any, ctx as any);
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(manager.delete).toHaveBeenCalledWith("worker-1");
  });
  it("reports stale or missing workers without throwing", async () => {
    const { manager, ctx } = setup("Close");
    manager.status.mockRejectedValueOnce(new Error("worker missing"));
    await openSubagentsControl(manager as any, ctx as any);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("worker missing"),
      "error",
    );
  });
  it("uses a non-interactive fallback", async () => {
    const { manager, ctx } = setup("Close");
    ctx.mode = "print";
    await openSubagentsControl(manager as any, ctx as any);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("worker-1  waiting", "info");
  });
});
