import { describe, expect, it, vi } from "vitest";
import { sessionName, TmuxAdapter, type Executor, type InteractiveExecutor } from "../../src/tmux/adapter.js";
import { SubagentError } from "../../src/types.js";

describe("tmux adapter", () => {
  it("uses deterministic validated names", () => {
    expect(sessionName("abc-123")).toBe("pi-sa-abc-123");
    expect(() => sessionName("bad name")).toThrow();
  });

  it("uses argument arrays and exact targets", async () => {
    const exec = vi.fn<Executor>().mockResolvedValue({ code: 0, stdout: "pi-sa-one\nother\n", stderr: "" });
    const tmux = new TmuxAdapter(exec);
    expect(await tmux.exists("abc")).toBe(true);
    expect(await tmux.list()).toEqual(["pi-sa-one"]);
    expect(tmux.attachArgs("abc")).toEqual(["attach-session", "-t", "=pi-sa-abc"]);
    expect(exec).toHaveBeenCalledWith("tmux", ["has-session", "-t", "=pi-sa-abc"]);
  });

  it("uses interactive executor with inherited stdio for attach", async () => {
    const exec = vi.fn<Executor>();
    const interactiveExec = vi.fn<InteractiveExecutor>().mockResolvedValue(0);
    const tmux = new TmuxAdapter(exec, interactiveExec);

    await tmux.attach("abc");
    expect(interactiveExec).toHaveBeenCalledWith("tmux", ["attach-session", "-t", "=pi-sa-abc"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws SubagentError when interactive attach fails", async () => {
    const exec = vi.fn<Executor>();
    const interactiveExec = vi.fn<InteractiveExecutor>().mockResolvedValue(1);
    const tmux = new TmuxAdapter(exec, interactiveExec);

    try {
      await tmux.attach("abc");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentError);
      expect((error as SubagentError).code).toBe("TMUX_ATTACH_FAILED");
    }
  });
});
