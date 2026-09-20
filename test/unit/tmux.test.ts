import { describe, expect, it, vi } from "vitest";
import { sessionName, TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";

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
});
