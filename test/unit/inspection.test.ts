import { describe, expect, it } from "vitest";
import { inspectWorker } from "../../src/extension/inspection.js";
import { workerId } from "../../src/types.js";

describe("worker inspection", () => {
  it("shows bounded durable activity, result, workspace metadata, and safe attach fallback", async () => {
    const id = workerId("worker-1");
    const state = {
      version: 1 as const,
      id,
      status: "completed" as const,
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 12,
    };
    const meta = {
      version: 1 as const,
      id,
      tmuxSession: "pi-sa-worker-1",
      createdAt: "2026-01-01T00:00:00Z",
      cwd: "/tmp/worktree",
      launch: { task: "x" },
      workspace: {
        mode: "worktree" as const,
        root: "/tmp/repo",
        worktree: "/tmp/worktree",
        branch: "pi/worker-1",
        changedFiles: ["src/a.ts"],
      },
    };
    const events = Array.from({ length: 12 }, (_, index) => ({
      version: 1 as const,
      seq: index + 1,
      at: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
      type: "tool_execution_start",
      data: { toolName: `tool-${index}` },
    }));
    const manager = {
      status: async () => state,
      result: async () => ({
        version: 1 as const,
        id,
        turn: 1,
        text: "done",
        completedAt: "2026-01-01T00:01:00Z",
        eventSeq: 12,
      }),
      store: {
        readMeta: async () => meta,
        readLog: async (_id: string, name: string) =>
          name === "events" ? events : [],
      },
    };
    const output = await inspectWorker(manager as any, id, 3);
    expect(output).toContain("branch: pi/worker-1");
    expect(output).toContain("changed: src/a.ts");
    expect(output).toContain("Latest result");
    expect(output).toContain("pi-tmux-subagent attach worker-1");
    expect(output.match(/^2026-.*\[tool\]/gm)).toHaveLength(3);
    expect(output).not.toContain("tool-8");
  });
});
