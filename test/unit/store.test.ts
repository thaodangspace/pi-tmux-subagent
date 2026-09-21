import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { reduceEvents } from "../../src/protocol/state.js";
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

  it("keeps concurrent event projection equivalent to a full replay", async () => {
    const { store, id } = await fixture();
    await Promise.all([
      store.appendEventAndProjectState(id, { type: "rpc_started" }),
      store.appendEventAndProjectState(id, { type: "command_ack", commandSeq: 1 }),
      store.appendEventAndProjectState(id, {
        type: "agent_start",
        commandSeq: 1,
        data: { turnContext: { initiatingCommandSeq: 1 } },
      }),
      store.appendEventAndProjectState(id, { type: "message_update" }),
    ]);
    const events = await store.readLog<any>(id, "events");
    const replayed = reduceEvents(
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
      events,
    );
    const cached = await store.readState(id);
    expect(cached).toMatchObject(replayed);
    expect(cached.lastEventSeq).toBe(events.length);
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

  it("removes stale completion dedup keys when rebuilding from the authoritative feed", async () => {
    const { store, id } = await fixture();
    const completion = {
      version: 1 as const,
      kind: "turn" as const,
      id,
      turn: 1,
      commandSeq: 1,
      resultSeq: 7,
      status: "completed" as const,
      summary: "done",
      hasDetails: true,
      completedAt: "2026-01-01T00:00:00Z",
    };
    await store.writeCompletion(completion);

    // Simulate authoritative feed rollback/repair while the derived key cache
    // and its old key survive.
    await writeFile(join(store.root, "completions.jsonl"), "");
    await rm(join(store.root, "completions.index.json"), { force: true });
    await store.writeCompletion(completion);

    const feed = await readFile(join(store.root, "completions.jsonl"), "utf8");
    expect(feed.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(feed).completion).toMatchObject({ resultSeq: 7 });
  });

  it("reads a bounded log tail without changing historical pagination", async () => {
    const { store, id } = await fixture();
    for (let i = 1; i <= 100; i++) {
      await store.appendEvent(id, { type: "event", data: "x".repeat(100) });
    }
    const tail = await store.readLogTail<any>(id, "events", 5, 2_000);
    expect(tail.map((event) => event.seq)).toEqual([96, 97, 98, 99, 100]);
    expect((await store.readLog<any>(id, "events", 1, 2)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("supports reading log with fromSeq cursor", async () => {
    const { store, id } = await fixture();
    for (let i = 1; i <= 5; i++) {
      await store.appendCommand(id, { type: "send", text: String(i) });
    }
    const tail = await store.readLog<any>(id, "commands", 3);
    expect(tail.map((c) => c.seq)).toEqual([3, 4, 5]);
  });

  it("supports bounded pagination with limit", async () => {
    const { store, id } = await fixture();
    for (let i = 1; i <= 5; i++) {
      await store.appendEvent(id, { type: "event", data: i });
    }
    const slice = await store.readLog<any>(id, "events", 2, 2);
    expect(slice.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("throws clear errors on invalid sequence and limit arguments", async () => {
    const { store, id } = await fixture();
    await expect(store.readLog(id, "events", 0)).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
    });
    await expect(store.readLog(id, "events", -1)).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
    });
    await expect(store.readLog(id, "events", 1.5)).rejects.toMatchObject({
      code: "INVALID_SEQUENCE",
    });
    await expect(store.readLog(id, "events", 1, 0)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(store.readLog(id, "events", 1, -5)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("throws WORKER_NOT_FOUND when reading log for nonexistent worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-"));
    roots.push(root);
    const store = new ProtocolStore(root);
    await expect(store.readLog("nonexistent", "events")).rejects.toMatchObject({
      code: "WORKER_NOT_FOUND",
    });
  });

  it("allows reentrant withWorkerLock within the same execution context", async () => {
    const { store, id } = await fixture();
    let innerRan = false;
    await store.withWorkerLock(id, async () => {
      await store.withWorkerLock(id, async () => {
        innerRan = true;
      });
    });
    expect(innerRan).toBe(true);
  });

  it("never breaks a lock while owner PID is alive, even if lock is old", async () => {
    const { store, id } = await fixture();
    const lockDir = store.path(id, ".worker.lock");
    const ownerFile = join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true });
    // Write current process.pid (alive)
    await writeFile(
      ownerFile,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }),
    );
    // Artificially age the directory mtime to 60s ago
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockDir, oldTime, oldTime);

    // Attempting to acquire from a separate async context should time out without breaking the lock
    await expect(
      new Promise((_, reject) => {
        setTimeout(async () => {
          try {
            await (store as any).acquire(lockDir);
            reject(new Error("Should not acquire"));
          } catch (err) {
            reject(err);
          }
        }, 0);
      }),
    ).rejects.toMatchObject({
      code: "STORE_LOCK_TIMEOUT",
    });

    await rm(lockDir, { recursive: true, force: true });
  });

  it("breaks a stale lock when owner PID is dead", async () => {
    const { store, id } = await fixture();
    const lockDir = store.path(id, ".worker.lock");
    const ownerFile = join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true });
    // PID 999999 is dead
    await writeFile(
      ownerFile,
      JSON.stringify({ pid: 999999, createdAt: Date.now() - 20_000 }),
    );

    // acquire should detect dead PID, remove the stale lock, and succeed
    await (store as any).acquire(lockDir);
    const newOwner = JSON.parse(await readFile(ownerFile, "utf8"));
    expect(newOwner.pid).toBe(process.pid);
    await rm(lockDir, { recursive: true, force: true });
  });

  it("repairs incomplete completions.jsonl tails before appending next completion", async () => {
    const { store, id } = await fixture();
    const ownerSessionKey = "sess-1";
    // 1. Write first completion
    await store.writeCompletion(
      {
        version: 1,
        id,
        turn: 1,
        resultSeq: 1,
        status: "completed",
        summary: "First",
        hasDetails: true,
        completedAt: new Date().toISOString(),
      },
      ownerSessionKey,
    );

    // 2. Corrupt tail of completions.jsonl with a partial unclosed JSON
    const feedPath = join(store.root, "completions.jsonl");
    const validContent = await readFile(feedPath, "utf8");
    await writeFile(feedPath, `${validContent}{"version":1,"cursor":2,"owner`);

    // 3. Write second completion
    await store.writeCompletion(
      {
        version: 1,
        id,
        turn: 2,
        resultSeq: 2,
        status: "completed",
        summary: "Second",
        hasDetails: true,
        completedAt: new Date().toISOString(),
      },
      ownerSessionKey,
    );

    // 4. Read completions feed and verify monotonic cursors 1 and 2
    const entries = await store.completions({
      consumer: "test",
      ownerSessionKey,
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.cursor)).toEqual([1, 2]);
    expect(entries[0]!.completion.summary).toBe("First");
    expect(entries[1]!.completion.summary).toBe("Second");
  });
});
