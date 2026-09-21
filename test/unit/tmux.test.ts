import { describe, expect, it, vi } from "vitest";
import {
  sessionName,
  TmuxAdapter,
  type Executor,
  type InteractiveExecutor,
} from "../../src/tmux/adapter.js";
import { SubagentError } from "../../src/types.js";

describe("tmux adapter", () => {
  it("uses deterministic validated names", () => {
    expect(sessionName("abc-123")).toBe("pi-sa-abc-123");
    expect(() => sessionName("bad name")).toThrow();
  });

  it("uses argument arrays and exact targets", async () => {
    const exec = vi
      .fn<Executor>()
      .mockImplementation(async (_command, args) =>
        args[0] === "list-panes"
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 0, stdout: "pi-sa-one\nother\n", stderr: "" },
      );
    const tmux = new TmuxAdapter(exec);
    expect(await tmux.exists("abc")).toBe(true);
    expect(await tmux.list()).toEqual(["pi-sa-one"]);
    expect(tmux.attachArgs("abc")).toEqual([
      "attach-session",
      "-t",
      "=pi-sa-abc",
    ]);
    expect(exec).toHaveBeenCalledWith("tmux", [
      "has-session",
      "-t",
      "=pi-sa-abc",
    ]);
  });

  it("creates a pane in the current tmux window", async () => {
    const previousTmux = process.env.TMUX;
    const previousPane = process.env.TMUX_PANE;
    process.env.TMUX = "/tmp/tmux,1,0";
    process.env.TMUX_PANE = "%3";
    const exec = vi
      .fn<Executor>()
      .mockImplementation(async (_command, args) => {
        if (args[0] === "has-session")
          return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "list-panes" && args.includes("-a"))
          return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "list-panes")
          return {
            code: 0,
            stdout: "%3\t120\t40\t\n%9\t120\t40\tabc\n",
            stderr: "",
          };
        if (args[0] === "split-window")
          return { code: 0, stdout: "%9\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      });
    const tmux = new TmuxAdapter(exec);
    try {
      expect(
        await tmux.create("abc", import.meta.dirname, import.meta.filename),
      ).toBe("%9");
      expect(exec).toHaveBeenCalledWith(
        "tmux",
        expect.arrayContaining(["split-window", "-t", "%3"]),
      );
      expect(exec).toHaveBeenCalledWith("tmux", [
        "set-option",
        "-p",
        "-t",
        "%9",
        "@pi_tmux_subagent_id",
        "abc",
      ]);
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousPane;
    }
  });

  it("uses interactive executor with inherited stdio for attach", async () => {
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const interactiveExec = vi.fn<InteractiveExecutor>().mockResolvedValue(0);
    const tmux = new TmuxAdapter(exec, interactiveExec);

    await tmux.attach("abc");
    expect(interactiveExec).toHaveBeenCalledWith("tmux", [
      "attach-session",
      "-t",
      "=pi-sa-abc",
    ]);
    expect(exec).toHaveBeenCalledWith("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{@pi_tmux_subagent_id}",
    ]);
  });

  it("throws SubagentError when interactive attach fails", async () => {
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "" });
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
