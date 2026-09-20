import { describe, expect, it, vi } from "vitest";
import { loadWorkerViews, renderSubagentsWidget, setSubagentsWidget } from "../../src/extension/widget.js";
import { workerId } from "../../src/types.js";
import type { WorkerActivityView } from "../../src/extension/projection.js";

const worker = (status: WorkerActivityView["status"] = "running"): WorkerActivityView => ({ id: "worker-long-id", name: "auth-scout", status, turn: 2, elapsedMs: 34_000, latestActivity: "[tool] grep refreshToken", latestActivityKind: "tool" });

describe("subagents widget", () => {
  it("renders an empty state in the subagents frame", () => expect(renderSubagentsWidget([], 80)).toEqual([
    "┌─ subagents ────────────────────────────────────────────────┐",
    "│  no agents                                                 │",
    "└────────────────────────────────────────────────────────────┘",
  ]));
  it.each(["running", "waiting", "completed", "failed", "orphaned"] as const)("renders %s state", (status) => {
    expect(renderSubagentsWidget([worker(status)], 80).join("\n")).toContain(status);
  });
  it("never exceeds narrow terminal width", () => {
    const lines = renderSubagentsWidget([worker()], 18);
    expect(lines.every((line) => line.length <= 18)).toBe(true);
    expect(lines).toHaveLength(3);
  });
  it("uses one aligned row per worker and shows current tool activity", () => {
    const lines = renderSubagentsWidget([worker(), { ...worker("waiting"), id: "reviewer", name: "reviewer", latestActivity: "ready", latestActivityKind: "state" }], 80);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("auth-scout  running");
    expect(lines[1]).toContain("grep refreshToken");
    expect(lines[2]).toContain("reviewer    waiting");
    expect(lines[2]).toContain("turn 2");
  });
  it("loads only workers belonging to the current workspace", async () => {
    const states = ["local", "other"].map((id) => ({ version: 1 as const, id: workerId(id), status: "waiting" as const, turn: 1, lastCommandSeq: 1, lastEventSeq: 1 }));
    const manager = {
      list: vi.fn(async () => states),
      store: {
        readMeta: vi.fn(async (id: string) => ({ version: 1, id, tmuxSession: `pi-sa-${id}`, createdAt: "2026-01-01T00:00:00Z", cwd: id === "local" ? "/repo" : "/other", launch: { task: "x" }, workspace: { mode: "current", root: id === "local" ? "/repo" : "/other" } })),
        readLog: vi.fn(async () => []),
        readResult: vi.fn(async () => undefined),
      },
    };
    const views = await loadWorkerViews(manager as any, Date.now(), "/repo");
    expect(views.map((view) => view.id)).toEqual(["local"]);
    expect(manager.store.readLog).toHaveBeenCalledTimes(2);
  });
  it("is a no-op without a UI and registers below the editor otherwise", () => {
    const setWidget = vi.fn();
    setSubagentsWidget({ hasUI: false, ui: { setWidget } } as any, [worker()]);
    expect(setWidget).not.toHaveBeenCalled();
    setSubagentsWidget({ hasUI: true, ui: { setWidget } } as any, [worker()]);
    expect(setWidget).toHaveBeenCalledWith("tmux-subagents", expect.any(Function), { placement: "belowEditor" });
  });
});
