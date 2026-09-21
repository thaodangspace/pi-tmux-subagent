import { describe, expect, it, vi } from "vitest";
import { registerExtension } from "../../src/extension/index.js";
import type { WorkerCompletion } from "../../src/protocol/types.js";
import { workerId } from "../../src/types.js";

function completion(id: string): WorkerCompletion {
  return {
    version: 1,
    id: workerId(id),
    turn: 1,
    commandSeq: 1,
    resultSeq: 2,
    status: "completed",
    summary: `${id} done`,
    hasDetails: true,
    completedAt: "2026-01-01T00:00:00Z",
  };
}

describe("extension completion lifecycle", () => {
  it("creates one notifier per started session and never sends before session_start", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const sent: any[] = [];
    const pending = new Map([
      ["session-a", [{ version: 1, cursor: 1, ownerSessionKey: "session-a", completion: completion("worker-a") }]],
      ["session-b", [{ version: 1, cursor: 2, ownerSessionKey: "session-b", completion: completion("worker-b") }]],
    ]);
    const manager = {
      completions: vi.fn(async ({ ownerSessionKey }: { ownerSessionKey: string }) =>
        pending.get(ownerSessionKey) ?? [],
      ),
      ackCompletion: vi.fn(async (_consumer: string, owner: string) => {
        pending.set(owner, []);
      }),
    };
    const pi = {
      on: vi.fn((name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn((message: any) => sent.push(message)),
    };

    registerExtension(pi as any, manager as any);
    expect(sent).toEqual([]);

    const context = (sessionId: string) => ({
      hasUI: false,
      sessionManager: { getSessionId: () => sessionId },
    });
    await handlers.get("session_start")?.({}, context("session-a"));
    expect(sent.map((message) => message.details.id)).toEqual(["worker-a"]);
    await handlers.get("session_shutdown")?.({}, context("session-a"));

    await handlers.get("session_start")?.({}, context("session-b"));
    expect(sent.map((message) => message.details.id)).toEqual([
      "worker-a",
      "worker-b",
    ]);
    expect(manager.completions).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSessionKey: "session-b" }),
    );
  });
});
