import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  const id = workerId("abc123");
  await store.create(
    {
      version: 1,
      id,
      tmuxSession: "pi-sa-abc123",
      createdAt: new Date().toISOString(),
      cwd: root,
      launch: { task: "x" },
    },
    {
      version: 1,
      id,
      status: "starting",
      turn: 0,
      lastCommandSeq: 0,
      lastEventSeq: 0,
    },
  );
  return { store, id };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("protocol store", () => {
  it("serializes concurrent monotonic appends", async () => {
    const { store, id } = await fixture();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.appendCommand(id, { type: "send", text: String(i) }),
      ),
    );
    expect((await store.readLog(id, "commands")).map((x) => x.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("ignores only an incomplete final record when reading", async () => {
    const { store, id } = await fixture();
    await store.appendEvent(id, { type: "ok" });
    await writeFile(
      store.path(id, "events.jsonl"),
      '{"version":1,"seq":1}\n{"seq":',
    );
    expect(await store.readLog(id, "events")).toHaveLength(1);
    await writeFile(store.path(id, "events.jsonl"), "{bad}\n");
    await expect(store.readLog(id, "events")).rejects.toThrow(/Invalid events/);
  });

  it("repairs incomplete JSONL tails before appending next record with contiguous sequences", async () => {
    const { store, id } = await fixture();
    // 1. Write a valid record
    const first = await store.appendCommand(id, {
      type: "prompt",
      text: "first",
    });
    expect(first.seq).toBe(1);

    // 2. Simulate a partial tail (e.g. process crashed mid-write)
    const logPath = store.path(id, "commands.jsonl");
    const validContent = await readFile(logPath, "utf8");
    await writeFile(logPath, `${validContent}{"version":1,"seq":2,"text":"par`);

    // 3. Append a new record
    const second = await store.appendCommand(id, {
      type: "send",
      text: "second",
    });
    expect(second.seq).toBe(2);

    // 4. Read the log successfully with contiguous sequence numbers
    const commands = await store.readLog<any>(id, "commands");
    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.seq)).toEqual([1, 2]);
    expect(commands[0].text).toBe("first");
    expect(commands[1].text).toBe("second");
  });

  it("repairs a log that contains only a partial tail with no previous newline", async () => {
    const { store, id } = await fixture();
    const logPath = store.path(id, "commands.jsonl");
    await writeFile(logPath, '{"version":1,"incomp');
    const first = await store.appendCommand(id, {
      type: "prompt",
      text: "fresh",
    });
    expect(first.seq).toBe(1);
    const commands = await store.readLog<any>(id, "commands");
    expect(commands).toHaveLength(1);
    expect(commands[0].seq).toBe(1);
  });

  it("durably reads completed and failed notifications after restart", async () => {
    const { store, id } = await fixture();
    await store.writeCompletion({
      version: 1,
      id,
      turn: 1,
      commandSeq: 1,
      resultSeq: 7,
      status: "completed",
      summary: "done",
      hasDetails: true,
      completedAt: "2026-01-01T00:00:00Z",
    });
    expect(
      await new ProtocolStore(store.root).readCompletion(id),
    ).toMatchObject({ status: "completed", resultSeq: 7 });

    await store.writeCompletion({
      version: 1,
      id,
      turn: 2,
      commandSeq: 2,
      resultSeq: 9,
      status: "failed",
      summary: "RPC exited",
      hasDetails: false,
      completedAt: "2026-01-01T00:01:00Z",
    });
    expect(
      await new ProtocolStore(store.root).readCompletion(id),
    ).toMatchObject({ status: "failed", summary: "RPC exited", resultSeq: 9 });
  });

  it("supports reading log with fromSeq cursor", async () => {
    const { store, id } = await fixture();
    for (let i = 1; i <= 5; i++) {
      await store.appendCommand(id, { type: "send", text: String(i) });
    }
    const tail = await store.readLog<any>(id, "commands", 3);
    expect(tail.map((c) => c.seq)).toEqual([3, 4, 5]);
  });
});
