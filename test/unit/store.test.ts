import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sa-")); roots.push(root); const store = new ProtocolStore(root); const id = workerId("abc123");
  await store.create({ version: 1, id, tmuxSession: "pi-sa-abc123", createdAt: new Date().toISOString(), cwd: root, launch: { task: "x" } }, { version: 1, id, status: "starting", turn: 0, lastCommandSeq: 0, lastEventSeq: 0 });
  return { store, id };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("protocol store", () => {
  it("serializes concurrent monotonic appends", async () => {
    const { store, id } = await fixture(); await Promise.all(Array.from({ length: 10 }, (_, i) => store.appendCommand(id, { type: "send", text: String(i) })));
    expect((await store.readLog(id, "commands")).map((x) => x.seq)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  });
  it("ignores only an incomplete final record", async () => {
    const { store, id } = await fixture(); await store.appendEvent(id, { type: "ok" });
    await writeFile(store.path(id, "events.jsonl"), '{"version":1,"seq":1}\n{"seq":');
    expect(await store.readLog(id, "events")).toHaveLength(1);
    await writeFile(store.path(id, "events.jsonl"), '{bad}\n');
    await expect(store.readLog(id, "events")).rejects.toThrow(/Invalid events/);
  });
});
