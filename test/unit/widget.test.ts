import { describe, expect, it, vi } from "vitest";
import { renderSubagentsWidget, setSubagentsWidget } from "../../src/extension/widget.js";
import type { WorkerActivityView } from "../../src/extension/projection.js";

const worker = (status: WorkerActivityView["status"] = "running"): WorkerActivityView => ({ id: "worker-long-id", name: "auth-scout", status, turn: 2, elapsedMs: 34_000, latestActivity: "[tool] grep refreshToken", latestActivityKind: "tool" });

describe("subagents widget", () => {
  it("renders a compact empty state", () => expect(renderSubagentsWidget([], 80)).toEqual(["Subagents  no agents"]));
  it.each(["running", "waiting", "completed", "failed", "orphaned"] as const)("renders %s state", (status) => {
    expect(renderSubagentsWidget([worker(status)], 80).join("\n")).toContain(status);
  });
  it("never exceeds narrow terminal width", () => {
    const lines = renderSubagentsWidget([worker()], 18);
    expect(lines.every((line) => line.length <= 18)).toBe(true);
    expect(lines).toHaveLength(2);
  });
  it("is a no-op without a UI and registers below the editor otherwise", () => {
    const setWidget = vi.fn();
    setSubagentsWidget({ hasUI: false, ui: { setWidget } } as any, [worker()]);
    expect(setWidget).not.toHaveBeenCalled();
    setSubagentsWidget({ hasUI: true, ui: { setWidget } } as any, [worker()]);
    expect(setWidget).toHaveBeenCalledWith("tmux-subagents", expect.any(Function), { placement: "belowEditor" });
  });
});
