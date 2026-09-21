import { describe, expect, it } from "vitest";
import {
  eventActivity,
  formatWorkerIdentity,
  modelSelectionLabel,
  projectWorker,
  recentActivity,
} from "../../src/extension/projection.js";
import type { WorkerEvent, WorkerState } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

const state = (status: WorkerState["status"] = "running"): WorkerState => ({
  version: 1,
  id: workerId("worker-1"),
  status,
  turn: 2,
  lastCommandSeq: 0,
  lastEventSeq: 0,
});
const event = (seq: number, type: string, data?: unknown): WorkerEvent => ({
  version: 1,
  seq,
  type,
  at: `2026-01-01T00:00:0${seq}.000Z`,
  ...(data === undefined ? {} : { data }),
});

describe("worker activity projection", () => {
  it("maps meaningful events and ignores streaming updates", () => {
    expect(
      eventActivity(event(1, "message_update", { delta: "noise" })),
    ).toBeUndefined();
    expect(
      eventActivity(
        event(2, "tool_execution_start", {
          toolName: "grep",
          args: { pattern: "token" },
        }),
      ),
    ).toMatchObject({ kind: "tool", text: '[tool] grep {"pattern":"token"}' });
    expect(eventActivity(event(3, "agent_settled"))).toMatchObject({
      kind: "state",
      text: "ready for next instruction",
    });
  });

  it.each([
    "running",
    "waiting",
    "completed",
    "failed",
    "stopped",
    "orphaned",
  ] as const)("represents %s workers", (status) => {
    expect(
      projectWorker(
        { state: state(status) },
        Date.parse("2026-01-01T00:01:00Z"),
      ),
    ).toMatchObject({ id: "worker-1", status, turn: 2 });
  });

  it("shows provider, model, and thinking, preferring the active RPC selection", () => {
    expect(
      modelSelectionLabel({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinking: "low",
      }),
    ).toBe("openai-codex/gpt-5.6-sol-low");
    expect(
      projectWorker({
        state: state(),
        meta: {
          version: 1,
          id: workerId("worker-1"),
          tmuxSession: "pi-sa-worker-1",
          createdAt: "2026-01-01T00:00:00Z",
          cwd: "/tmp",
          launch: { task: "task", provider: "configured", model: "configured" },
          activeModel: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            thinking: "low",
          },
        },
      }),
    ).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "low",
      modelLabel: "openai-codex/gpt-5.6-sol-low",
    });
  });

  it("is deterministic, bounded, and combines command and event history", () => {
    const input = {
      state: state(),
      commands: [
        {
          version: 1 as const,
          seq: 1,
          at: "2026-01-01T00:00:01.500Z",
          type: "send" as const,
          text: "follow up",
        },
      ],
      events: [
        event(1, "message_update"),
        event(2, "message_end", {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(200) }],
          },
        }),
      ],
    };
    const view = projectWorker(input, 0, 20);
    expect(view.latestActivity).toHaveLength(20);
    expect(view.latestActivity?.endsWith("…")).toBe(true);
    expect(recentActivity(input, 10).map((item) => item.kind)).toEqual([
      "command",
      "assistant",
    ]);
  });

  it("reads agent from meta.launch.agent and preserves undefined for legacy metadata", () => {
    const withAgent = projectWorker({
      state: state(),
      meta: {
        version: 1,
        id: workerId("worker-1"),
        tmuxSession: "pi-sa-worker-1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: "/tmp",
        launch: { task: "task", agent: "reviewer", name: "auth-review" },
      },
    });
    expect(withAgent.agent).toBe("reviewer");
    expect(withAgent.name).toBe("auth-review");

    const legacy = projectWorker({
      state: state(),
      meta: {
        version: 1,
        id: workerId("worker-1"),
        tmuxSession: "pi-sa-worker-1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: "/tmp",
        launch: { task: "task", name: "legacy-worker" },
      },
    });
    expect(legacy.agent).toBeUndefined();
    expect(legacy.name).toBe("legacy-worker");
  });

  describe("formatWorkerIdentity", () => {
    it("renders name [agent] when name and agent differ", () => {
      expect(
        formatWorkerIdentity({
          name: "auth-review",
          agent: "reviewer",
          id: "w-1",
        }),
      ).toBe("auth-review [reviewer]");
    });

    it("renders single label when name and agent are identical", () => {
      expect(
        formatWorkerIdentity({
          name: "reviewer",
          agent: "reviewer",
          id: "w-1",
        }),
      ).toBe("reviewer");
    });

    it("renders agent name when explicit name is absent but agent exists", () => {
      expect(
        formatWorkerIdentity({
          agent: "reviewer",
          id: "w-1",
        }),
      ).toBe("reviewer");
    });

    it("renders worker name when agent is absent", () => {
      expect(
        formatWorkerIdentity({
          name: "custom-worker",
          id: "w-1",
        }),
      ).toBe("custom-worker");
    });

    it("falls back to worker id when neither name nor agent is present", () => {
      expect(
        formatWorkerIdentity({
          id: "w-1",
        }),
      ).toBe("w-1");
    });
  });
});
