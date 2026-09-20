import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { TmuxAdapter, type Executor } from "../../src/tmux/adapter.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))));
describe("manager command delivery", () => {
  it("enqueues ordered control commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-")); roots.push(root);
    const exec = vi.fn<Executor>().mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const manager = new Manager({ store: new ProtocolStore(root), tmux: new TmuxAdapter(exec), runnerFile: process.execPath });
    await manager.spawn({ task: "first" }, root, "worker1");
    await manager.send("worker1", "second"); await manager.steer("worker1", "third"); await manager.abort("worker1");
    const commands = await manager.store.readLog("worker1", "commands");
    expect(commands.map((x: any) => [x.seq, x.type])).toEqual([[1,"prompt"],[2,"send"],[3,"steer"],[4,"abort"]]);
  });
});
