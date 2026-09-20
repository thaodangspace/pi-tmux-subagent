import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityWatcher } from "../../src/extension/watcher.js";
import { workerId } from "../../src/types.js";

afterEach(() => vi.useRealTimers());
describe("activity watcher", () => {
  it("refreshes transitions, coalesces unchanged state, tolerates failures, and stops cleanly", async () => {
    vi.useFakeTimers();
    let status: "running" | "waiting" = "running";
    let fail = false;
    const state = () => ({
      version: 1 as const,
      id: workerId("worker-1"),
      status,
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: status === "running" ? 1 : 2,
    });
    const manager = {
      list: vi.fn(async () => {
        if (fail) throw new Error("partial write");
        return [state()];
      }),
      store: {
        readMeta: vi.fn(async () => ({
          version: 1,
          id: workerId("worker-1"),
          tmuxSession: "pi-sa-worker-1",
          createdAt: "2026-01-01T00:00:00Z",
          cwd: "/tmp",
          launch: { task: "x" },
        })),
        readLog: vi.fn(async (_id: string, name: string) =>
          name === "events"
            ? [
                {
                  version: 1,
                  seq: status === "running" ? 1 : 2,
                  at: "2026-01-01T00:00:01Z",
                  type: status === "running" ? "agent_start" : "agent_settled",
                },
              ]
            : [],
        ),
        readResult: vi.fn(async () => undefined),
      },
    };
    const setWidget = vi.fn();
    const errors = vi.fn();
    const watcher = new ActivityWatcher(
      manager as any,
      { hasUI: true, ui: { setWidget } } as any,
      { intervalMs: 10, onError: errors },
    );
    await watcher.start();
    expect(setWidget).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(setWidget).toHaveBeenCalledTimes(1);
    status = "waiting";
    await vi.advanceTimersByTimeAsync(10);
    expect(setWidget).toHaveBeenCalledTimes(2);
    const latestWidget = setWidget.mock.calls.at(-1)?.[1] as () => {
      render: (width: number) => string[];
    };
    expect(latestWidget().render(80).join("\n")).toContain("waiting");
    fail = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveBeenCalledOnce();
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.list).toHaveBeenCalledTimes(4);
  });
});
