import { describe, expect, it, vi } from "vitest";
import {
  buildLayout,
  chooseLayout,
  DEFAULT_LAYOUT,
  TmuxLayoutManager,
} from "../../src/tmux/layout.js";
import type { Executor } from "../../src/tmux/adapter.js";

describe("tmux layout policy", () => {
  it("chooses modes at the configured boundaries", () => {
    expect(chooseLayout(0)).toBe("main-only");
    expect(chooseLayout(1)).toBe("right-stack");
    expect(chooseLayout(4)).toBe("right-stack");
    expect(chooseLayout(5)).toBe("right-grid");
    expect(chooseLayout(8)).toBe("right-grid");
    expect(chooseLayout(9)).toBe("overflow");
    expect(chooseLayout(3, { ...DEFAULT_LAYOUT, maxVerticalStack: 2 })).toBe(
      "right-grid",
    );
  });

  it("builds a 70/30 stack using stable pane ids", () => {
    const layout = buildLayout(100, 40, "%1", ["%7", "%9"]);
    expect(layout).toMatch(/^[0-9a-f]{4},100x40,0,0\{/);
    expect(layout).toContain("70x40,0,0,1");
    expect(layout).toContain("29x40,71,0[");
    expect(layout).toContain(",7");
    expect(layout).toContain(",9");
  });

  it("builds two-column rows after the stack threshold", () => {
    const layout = buildLayout(120, 40, "%1", ["%2", "%3", "%4", "%5", "%6"]);
    expect(layout).toContain("120x40,0,0{");
    expect(layout).toMatch(/35x13,85,0\{/);
    expect(layout).toContain(",2");
    expect(layout).toContain(",6");
  });

  it("caps panes admitted to the main window", async () => {
    const rows = [
      "%1\t120\t40\t",
      ...Array.from({ length: 8 }, (_, i) => `%${i + 2}\t120\t40\ta${i}`),
    ].join("\n");
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 0, stdout: `${rows}\n`, stderr: "" });
    const manager = new TmuxLayoutManager(exec, "%1");
    expect(await manager.hasVisibleCapacity()).toBe(false);
  });

  it("does not disturb panes it does not manage", async () => {
    const exec = vi
      .fn<Executor>()
      .mockResolvedValueOnce({
        code: 0,
        stdout: "%1\t120\t40\t\n%2\t120\t40\t\n%3\t120\t40\tagent\n",
        stderr: "",
      });
    const manager = new TmuxLayoutManager(exec, "%1");
    await manager.rebalance();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("focuses panes by stable pane id", async () => {
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new TmuxLayoutManager(exec, "%1");
    await manager.focusAgentPane("%9");
    await manager.focusMainPane();
    expect(exec).toHaveBeenNthCalledWith(1, "tmux", [
      "select-pane",
      "-t",
      "%9",
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, "tmux", [
      "select-pane",
      "-t",
      "%1",
    ]);
  });
});
