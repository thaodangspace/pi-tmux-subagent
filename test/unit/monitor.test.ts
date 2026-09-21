import { describe, expect, it } from "vitest";
import { SubagentMonitor } from "../../src/runner/monitor.js";

describe("monitor: width-sensitive rendering", () => {
  it("renders wide/tall pane with full header and structured activity", () => {
    const monitor = new SubagentMonitor({
      id: "worker-1",
      name: "auth-scout",
      agent: "researcher",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: "running",
      turn: 3,
      startedAt: new Date(Date.now() - 42_000).toISOString(),
    });

    // Simulate tool activity and streaming text
    monitor.handleEvent({
      kind: "tool_start",
      toolName: "grep",
      detail: "refreshToken",
    });
    monitor.handleEvent({
      kind: "text_delta",
      delta: "Found implementation in...",
    });
    monitor.handleEvent({
      kind: "message_end",
      role: "assistant",
    });
    monitor.handleEvent({
      kind: "tool_start",
      toolName: "read",
      detail: "src/auth/token.ts",
    });
    monitor.handleEvent({
      kind: "text_delta",
      delta: "Analyzing token rotation...",
    });

    const lines = monitor.render(40, 16);

    expect(lines).toHaveLength(16);
    expect(lines.every((line) => line.length === 40)).toBe(true);

    // Header inspection
    expect(lines[0]).toContain("┌ auth-scout ");
    expect(lines[0]?.endsWith("┐")).toBe(true);
    expect(lines[1]).toContain("agent   researcher");
    expect(lines[2]).toContain("model   anthropic/claude-sonnet-4-5");
    expect(lines[3]).toContain("status  ● running     turn 3");
    expect(lines[4]).toContain("time    00:42");
    expect(lines[5]).toBe(`├${"─".repeat(38)}┤`);

    // Activity area inspection
    const output = lines.join("\n");
    expect(output).toContain("TOOL grep");
    expect(output).toContain("refreshToken");
    expect(output).toContain("Found implementation in...");
    expect(output).toContain("TOOL read");
    expect(output).toContain("src/auth/token.ts");
    expect(output).toContain("Analyzing token rotation...");

    // Bottom border
    expect(lines[15]).toBe(`└${"─".repeat(38)}┘`);
  });

  it("renders narrow pane with compact 1-line header to maximize activity space", () => {
    const monitor = new SubagentMonitor({
      id: "worker-2",
      name: "auth-scout",
      status: "running",
      turn: 2,
      startedAt: new Date(Date.now() - 15_000).toISOString(),
    });

    monitor.handleEvent({
      kind: "tool_start",
      toolName: "grep",
      detail: "token",
    });

    // Narrow width: 32 cols, height: 8 rows
    const lines = monitor.render(32, 8);

    expect(lines).toHaveLength(8);
    expect(lines.every((line) => line.length === 32)).toBe(true);

    // Top border
    expect(lines[0]).toContain("┌ auth-scout ");
    // Line 1: compact status header
    expect(lines[1]).toContain("● running");
    expect(lines[1]).toContain("t2");
    expect(lines[1]).toContain("00:15");
    // Line 2: divider
    expect(lines[2]).toBe(`├${"─".repeat(30)}┤`);
    // Activity
    expect(lines[3]).toContain("TOOL grep");
    expect(lines[4]).toContain("token");
    // Bottom border
    expect(lines[7]).toBe(`└${"─".repeat(30)}┘`);
  });

  it("renders very small pane without box borders to maximize readable content", () => {
    const monitor = new SubagentMonitor({
      id: "worker-3",
      name: "mini",
      status: "running",
      turn: 1,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    monitor.handleEvent({
      kind: "tool_start",
      toolName: "grep",
      detail: "secret",
    });

    // Very small pane: 20 cols, 4 rows
    const lines = monitor.render(20, 4);

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.length <= 20)).toBe(true);

    expect(lines[0]).toContain("mini: ● running");
    expect(lines[1]).toContain("turn 1");
    expect(lines[1]).toContain("00:05");
    expect(lines[2]).toContain("TOOL grep");
    expect(lines[3]).toContain("secret");
  });

  it("renders height 1 in very small pane gracefully", () => {
    const monitor = new SubagentMonitor({
      id: "w-1",
      name: "scout",
      status: "running",
      turn: 1,
      startedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const lines = monitor.render(25, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length <= 25).toBe(true);
    expect(lines[0]).toContain("scout");
    expect(lines[0]).toContain("● running");
  });

  it("bounds long single-line values and does not overflow borders", () => {
    const monitor = new SubagentMonitor({
      id: "worker-with-a-very-long-id-that-exceeds-normal-pane-width",
      name: "very-long-subagent-worker-name-that-should-be-truncated",
      provider: "openai-extremely-long-provider-name",
      model: "gpt-5-ultra-super-deluxe-version-latest-snapshot",
      status: "running",
      turn: 1,
    });

    monitor.handleEvent({
      kind: "tool_start",
      toolName: "bash",
      detail: "x".repeat(300),
    });

    const lines = monitor.render(40, 10);
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => line.length === 40)).toBe(true);
    expect(lines[0]?.endsWith("┐")).toBe(true);
    expect(lines[lines.length - 1]?.endsWith("┘")).toBe(true);
  });

  it("word-wraps long assistant text blocks to fit content area", () => {
    const monitor = new SubagentMonitor({
      id: "w-wrap",
      name: "writer",
      status: "running",
      turn: 1,
    });

    monitor.handleEvent({
      kind: "text_delta",
      delta:
        "This is a longer paragraph of text that needs to wrap neatly across several lines inside the subagent pane.",
    });

    const lines = monitor.render(40, 12);
    expect(lines.every((line) => line.length === 40)).toBe(true);
    const textLines = lines.filter(
      (l) => l.includes("paragraph") || l.includes("several"),
    );
    expect(textLines.length).toBeGreaterThan(0);
  });

  it("auto-scrolls activity area to show latest lines when activity exceeds capacity", () => {
    const monitor = new SubagentMonitor({
      id: "w-scroll",
      name: "scout",
      status: "running",
      turn: 1,
    });

    // Add 10 tool invocations
    for (let i = 1; i <= 10; i++) {
      monitor.handleEvent({
        kind: "tool_start",
        toolName: `tool-${i}`,
        detail: `arg-${i}`,
      });
    }

    // Render with 12 lines total (capacity for ~6 activity lines)
    const lines = monitor.render(50, 12);
    const content = lines.join("\n");

    // Earlier tools should have scrolled off
    expect(content).not.toContain("tool-2");
    expect(content).not.toContain("tool-3");
    // Latest tools should be visible
    expect(content).toContain("tool-9");
    expect(content).toContain("tool-10");
  });

  it("reflects status updates (unresponsive, error, waiting)", () => {
    const monitor = new SubagentMonitor({
      id: "w-status",
      name: "scout",
      status: "running",
      turn: 1,
    });

    monitor.handleEvent({ kind: "unresponsive", message: "RPC timeout" });
    let lines = monitor.render(50, 12);
    expect(lines.join("\n")).toContain("UNRESPONSIVE RPC timeout");

    monitor.handleEvent({ kind: "error", message: "command execution failed" });
    lines = monitor.render(50, 12);
    expect(lines.join("\n")).toContain("ERROR command execution failed");

    monitor.handleEvent({ kind: "agent_settled" });
    lines = monitor.render(50, 12);
    expect(lines.join("\n")).toContain("waiting");
  });

  it("writes ANSI cursor controls and hides/restores cursor in TTY mode", () => {
    const chunks: string[] = [];
    const mockOutput = {
      write(chunk: string) {
        chunks.push(chunk);
      },
      isTTY: true,
      columns: 40,
      rows: 10,
    };

    const monitor = new SubagentMonitor({
      id: "w-tty",
      name: "tty-worker",
      status: "running",
      turn: 1,
      output: mockOutput as any,
      isTty: true,
    });

    monitor.start();
    // Should have hidden cursor and written first frame at cursor home
    expect(chunks[0]).toBe("\x1b[?25l");
    expect(chunks[1]).toContain("\x1b[H");
    expect(chunks[1]).toContain("tty-worker");

    monitor.stop();
    // Should have restored cursor
    expect(chunks[chunks.length - 1]).toBe("\x1b[?25h");
  });
});
