import { describe, expect, it } from "vitest";
import { eventActivity, projectWorker, recentActivity } from "../../src/extension/projection.js";
import type { WorkerEvent, WorkerState } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const state = (status: WorkerState["status"] = "running"): WorkerState => ({ version: 1, id: workerId("worker-1"), status, turn: 2, lastCommandSeq: 0, lastEventSeq: 0 });
const event = (seq: number, type: string, data?: unknown): WorkerEvent => ({ version: 1, seq, type, at: `2026-01-01T00:00:0${seq}.000Z`, ...(data === undefined ? {} : { data }) });

describe("worker activity projection", () => {
  it("maps meaningful events and ignores streaming updates", () => {
    expect(eventActivity(event(1, "message_update", { delta: "noise" }))).toBeUndefined();
    expect(eventActivity(event(2, "tool_execution_start", { toolName: "grep", args: { pattern: "token" } }))).toMatchObject({ kind: "tool", text: "[tool] grep {\"pattern\":\"token\"}" });
    expect(eventActivity(event(3, "agent_settled"))).toMatchObject({ kind: "state", text: "ready for next instruction" });
  });

  it.each(["running", "waiting", "completed", "failed", "stopped", "orphaned"] as const)("represents %s workers", (status) => {
    expect(projectWorker({ state: state(status) }, Date.parse("2026-01-01T00:01:00Z"))).toMatchObject({ id: "worker-1", status, turn: 2 });
  });

  it("is deterministic, bounded, and combines command and event history", () => {
    const input = {
      state: state(),
      commands: [{ version: 1 as const, seq: 1, at: "2026-01-01T00:00:01.500Z", type: "send" as const, text: "follow up" }],
      events: [event(1, "message_update"), event(2, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200) }] } })],
    };
    const view = projectWorker(input, 0, 20);
    expect(view.latestActivity).toHaveLength(20);
    expect(view.latestActivity?.endsWith("…")).toBe(true);
    expect(recentActivity(input, 10).map((item) => item.kind)).toEqual(["command", "assistant"]);
  });
});
