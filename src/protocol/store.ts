import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { SubagentError, workerId, type WorkerId } from "../types.js";
import type {
  CompletionFeedEntry,
  CompletionQuery,
  WorkerCommand,
  WorkerCompletion,
  WorkerEvent,
  WorkerMeta,
  WorkerResult,
  WorkerState,
} from "./types.js";
import { reduceEvents } from "./state.js";

const lockStorage = new AsyncLocalStorage<Set<string>>();

export function completionDedupKey(c: WorkerCompletion): string {
  return c.kind === "worker"
    ? `${c.id}:worker:${c.resultSeq}:${c.status}`
    : `${c.id}:${c.turn}:${c.resultSeq}:${c.status}`;
}

export const DEFAULT_REGISTRY_ROOT = join(homedir(), ".pi", "tmux-subagents");
export type LogName = "commands" | "events";

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${path.split("/").pop()}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function getLastSeqAndRepair(filePath: string): Promise<number> {
  let handle;
  try {
    handle = await open(filePath, "r+");
  } catch (err: any) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  try {
    const stats = await handle.stat();
    let size = stats.size;
    if (size === 0) return 0;

    const bufferSize = Math.min(size, 65536);
    const buffer = Buffer.alloc(bufferSize);
    let position = size - bufferSize;
    const { bytesRead } = await handle.read(buffer, 0, bufferSize, position);

    const lastByte = buffer[bytesRead - 1];
    if (lastByte !== 0x0a) {
      let lastNewlineIdx = buffer.lastIndexOf(0x0a, bytesRead - 1);
      while (lastNewlineIdx === -1 && position > 0) {
        const toRead = Math.min(position, 65536);
        position -= toRead;
        const prevBuffer = Buffer.alloc(toRead);
        await handle.read(prevBuffer, 0, toRead, position);
        lastNewlineIdx = prevBuffer.lastIndexOf(0x0a);
        if (lastNewlineIdx !== -1) {
          const truncateOffset = position + lastNewlineIdx + 1;
          await handle.truncate(truncateOffset);
          size = truncateOffset;
          break;
        }
      }
      if (lastNewlineIdx === -1 && position === 0) {
        await handle.truncate(0);
        return 0;
      } else if (lastNewlineIdx !== -1 && size === stats.size) {
        const truncateOffset = position + lastNewlineIdx + 1;
        await handle.truncate(truncateOffset);
        size = truncateOffset;
      }
    }

    if (size === 0) return 0;

    const readLen = Math.min(size, 65536);
    let readPos = size - readLen;
    const tailBuf = Buffer.alloc(readLen);
    await handle.read(tailBuf, 0, readLen, readPos);

    const prevNewline = tailBuf.lastIndexOf(0x0a, readLen - 2);
    while (prevNewline === -1 && readPos > 0) {
      const toRead = Math.min(readPos, 65536);
      readPos -= toRead;
      const prevBuf = Buffer.alloc(toRead);
      await handle.read(prevBuf, 0, toRead, readPos);
      const nl = prevBuf.lastIndexOf(0x0a);
      if (nl !== -1) {
        const lineLen = size - 1 - (readPos + nl + 1);
        const lineBuf = Buffer.alloc(lineLen);
        await handle.read(lineBuf, 0, lineLen, readPos + nl + 1);
        const record = JSON.parse(lineBuf.toString("utf8").trim());
        return record.seq ?? record.cursor ?? 0;
      }
    }

    const startOffset = prevNewline === -1 ? 0 : prevNewline + 1;
    const line = tailBuf
      .subarray(startOffset, readLen - 1)
      .toString("utf8")
      .trim();
    if (!line) return 0;
    const record = JSON.parse(line);
    return record.seq ?? record.cursor ?? 0;
  } finally {
    await handle.close();
  }
}

export class ProtocolStore {
  private readonly completionOffsets = new Map<string, number>();
  constructor(readonly root = DEFAULT_REGISTRY_ROOT) {}
  dir(id: WorkerId | string): string {
    return join(this.root, workerId(String(id)));
  }
  path(id: WorkerId | string, name: string): string {
    return join(this.dir(id), name);
  }
  async create(meta: WorkerMeta, state: WorkerState): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const dir = this.dir(meta.id);
    try {
      await mkdir(dir, { recursive: false, mode: 0o700 });
    } catch (error: any) {
      if (error.code === "EEXIST")
        throw new SubagentError(
          "WORKER_EXISTS",
          `Worker already exists: ${meta.id}`,
        );
      throw error;
    }
    await Promise.all([
      writeFile(join(dir, "commands.jsonl"), "", { mode: 0o600 }),
      writeFile(join(dir, "events.jsonl"), "", { mode: 0o600 }),
    ]);
    await this.writeMeta(meta);
    await this.writeState(state);
  }
  async writeMeta(value: WorkerMeta): Promise<void> {
    await atomicJson(this.path(value.id, "meta.json"), value);
  }
  async writeState(value: WorkerState): Promise<void> {
    await atomicJson(this.path(value.id, "state.json"), value);
  }
  async writeResult(value: WorkerResult): Promise<void> {
    const resultSeq = value.resultSeq ?? value.eventSeq;
    const historyDir = this.path(value.id, "results");
    const historyPath = join(historyDir, `${value.turn}-${resultSeq}.json`);
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(historyPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const existing = await this.readJson<WorkerResult>(
        value.id,
        `results/${value.turn}-${resultSeq}.json`,
      );
      if (JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new SubagentError(
          "RESULT_CORRELATION_CONFLICT",
          `Result ${value.id} turn ${value.turn} sequence ${resultSeq} already exists with different content`,
        );
      }
    }
    // Backward-compatible latest-result cache; immutable history above is
    // authoritative and is always persisted first.
    await atomicJson(this.path(value.id, "result.json"), value);
  }
  async writeCompletion(
    value: WorkerCompletion,
    ownerOverride?: string | null,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, ".completions.lock");
    await this.acquire(lock);
    try {
      const feedPath = join(this.root, "completions.jsonl");
      const indexPath = join(this.root, "completions.index.json");
      const keysDir = join(this.root, "completions.keys");
      const targetKey = completionDedupKey(value);
      const targetHash = createHash("sha256").update(targetKey).digest("hex");
      const targetKeyPath = join(keysDir, targetHash.slice(0, 2), targetHash.slice(2));

      // Repair partial completion-feed tails before reading or appending
      const lastCursor = await getLastSeqAndRepair(feedPath);
      let feedSize = 0;
      try {
        feedSize = (await stat(feedPath)).size;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }

      let index: { offset: number; lastCursor: number } | undefined;
      try {
        const raw = await readFile(indexPath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          typeof parsed.offset === "number" &&
          typeof parsed.lastCursor === "number"
        ) {
          index = { offset: parsed.offset, lastCursor: parsed.lastCursor };
        }
      } catch {
        /* index missing or invalid */
      }

      if (!index || feedSize < index.offset) {
        await mkdir(keysDir, { recursive: true, mode: 0o700 });
        const allEntries = await this.readCompletionFeed();
        for (const { completion: c } of allEntries) {
          const k = completionDedupKey(c);
          const h = createHash("sha256").update(k).digest("hex");
          const kp = join(keysDir, h.slice(0, 2), h.slice(2));
          await mkdir(dirname(kp), { recursive: true, mode: 0o700 });
          await writeFile(kp, "", { flag: "w", mode: 0o600 });
        }
        index = {
          offset: feedSize,
          lastCursor,
        };
      } else if (feedSize > index.offset) {
        const newRecords = await this.readCompletionFeedFrom(
          index.offset,
          index.lastCursor,
        );
        for (const { entry, endOffset } of newRecords) {
          const c = entry.completion;
          const k = completionDedupKey(c);
          const h = createHash("sha256").update(k).digest("hex");
          const kp = join(keysDir, h.slice(0, 2), h.slice(2));
          await mkdir(dirname(kp), { recursive: true, mode: 0o700 });
          await writeFile(kp, "", { flag: "w", mode: 0o600 });
          index.lastCursor = entry.cursor;
          index.offset = endOffset;
        }
      }

      let existing = false;
      try {
        await stat(targetKeyPath);
        existing = true;
      } catch {
        /* key does not exist */
      }

      if (!existing) {
        let ownerSessionKey: string | null = ownerOverride ?? null;
        if (ownerOverride === undefined) {
          try {
            ownerSessionKey =
              (await this.readMeta(value.id)).ownerSessionKey ?? null;
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        const cursor = index.lastCursor + 1;
        const entry: CompletionFeedEntry = {
          version: 1,
          cursor,
          ownerSessionKey,
          completion: value,
        };
        await appendFile(feedPath, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          flag: "a",
          mode: 0o600,
        });
        let newSize = feedSize;
        try {
          newSize = (await stat(feedPath)).size;
        } catch {
          /* ignore stat error */
        }
        await mkdir(dirname(targetKeyPath), { recursive: true, mode: 0o700 });
        await writeFile(targetKeyPath, "", { flag: "w", mode: 0o600 });
        index.lastCursor = cursor;
        index.offset = newSize;
      }
      await atomicJson(indexPath, index);
      // The per-worker file is only a latest-completion cache. The feed above
      // is the durable history and must be published first.
      await atomicJson(this.path(value.id, "completion.json"), value);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async completions(query: CompletionQuery): Promise<CompletionFeedEntry[]> {
    this.consumerPath(query.consumer, query.ownerSessionKey);
    if (query.after !== undefined) {
      const after = this.validCursor(query.after);
      return (await this.readCompletionFeed()).filter(
        (entry) =>
          entry.cursor > after &&
          entry.ownerSessionKey === query.ownerSessionKey,
      );
    }

    const checkpoint = await this.readCompletionCheckpoint(
      query.consumer,
      query.ownerSessionKey,
    );
    const scanned = await this.readCompletionFeedFrom(
      checkpoint.offset,
      checkpoint.offset === 0 ? 0 : checkpoint.cursor,
    );
    // Legacy checkpoints did not contain byte offsets. They migrate after one
    // full scan while retaining the already acknowledged cursor.
    const records = scanned.filter(
      ({ entry }) => entry.cursor > checkpoint.cursor,
    );
    const owned = records.filter(
      ({ entry }) => entry.ownerSessionKey === query.ownerSessionKey,
    );
    for (const record of owned) {
      this.completionOffsets.set(
        `${query.ownerSessionKey}:${record.entry.cursor}`,
        record.endOffset,
      );
    }
    // Entries belonging only to other owners are safe to skip durably. This
    // keeps an idle owner's polling cost bounded even on a busy shared feed.
    if (!owned.length && records.length) {
      const last = records.at(-1)!;
      await this.writeCompletionCheckpoint(
        query.consumer,
        query.ownerSessionKey,
        last.entry.cursor,
        last.endOffset,
      );
    }
    return owned.map(({ entry }) => entry);
  }

  async ackCompletion(
    consumer: string,
    ownerSessionKey: string,
    cursor: number,
  ): Promise<void> {
    const value = this.validCursor(cursor);
    const cursorPath = this.consumerPath(consumer, ownerSessionKey);
    const lock = `${cursorPath}.lock`;
    await mkdir(dirname(cursorPath), { recursive: true, mode: 0o700 });
    await this.acquire(lock);
    try {
      let offset = this.completionOffsets.get(`${ownerSessionKey}:${value}`);
      let entry: CompletionFeedEntry | undefined;
      if (offset === undefined) {
        const records = await this.readCompletionFeedFrom(0, 0);
        const record = records.find(({ entry }) => entry.cursor === value);
        entry = record?.entry;
        offset = record?.endOffset;
      } else {
        entry = { ownerSessionKey } as CompletionFeedEntry;
      }
      if (!entry || entry.ownerSessionKey !== ownerSessionKey || offset === undefined) {
        throw new SubagentError(
          "INVALID_COMPLETION_CURSOR",
          `Completion cursor ${value} has not been published for this owner`,
        );
      }
      const current = await this.readCompletionCheckpoint(
        consumer,
        ownerSessionKey,
      );
      if (value > current.cursor) {
        await this.writeCompletionCheckpoint(
          consumer,
          ownerSessionKey,
          value,
          offset,
        );
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async readCompletionFeedFrom(
    offset: number,
    afterCursor: number,
  ): Promise<Array<{ entry: CompletionFeedEntry; endOffset: number }>> {
    const path = join(this.root, "completions.jsonl");
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      if (offset > size) return this.readCompletionFeedFrom(0, 0);
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      const records: Array<{ entry: CompletionFeedEntry; endOffset: number }> = [];
      let start = 0;
      let expected = afterCursor + 1;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== 0x0a) continue;
        const line = buffer.subarray(start, index).toString("utf8");
        start = index + 1;
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as CompletionFeedEntry;
          if (parsed.cursor !== expected || !parsed.completion)
            throw new Error("invalid cursor");
          const entry = {
            ...parsed,
            ownerSessionKey: parsed.ownerSessionKey ?? null,
          };
          records.push({ entry, endOffset: offset + start });
          expected++;
        } catch (error) {
          throw new SubagentError("CORRUPT_LOG", "Invalid completions.jsonl record", error);
        }
      }
      return records;
    } finally {
      await handle.close();
    }
  }

  private async readCompletionFeed(): Promise<CompletionFeedEntry[]> {
    let text: string;
    try {
      text = await readFile(join(this.root, "completions.jsonl"), "utf8");
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const lines = text.split("\n");
    const entries: CompletionFeedEntry[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as CompletionFeedEntry;
        if (entry.cursor !== entries.length + 1 || !entry.completion) {
          throw new Error("invalid cursor");
        }
        // Records produced before owner routing are deliberately unbound and
        // must never be delivered automatically to an arbitrary Pi session.
        entries.push({
          ...entry,
          ownerSessionKey: entry.ownerSessionKey ?? null,
        });
      } catch (error) {
        if (index === lines.length - 1 && !text.endsWith("\n")) break;
        throw new SubagentError(
          "CORRUPT_LOG",
          `Invalid completions.jsonl record ${index + 1}`,
          error,
        );
      }
    }
    return entries;
  }

  private consumerPath(consumer: string, ownerSessionKey: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(consumer)) {
      throw new SubagentError(
        "INVALID_COMPLETION_CONSUMER",
        `Invalid completion consumer: ${consumer}`,
      );
    }
    if (!ownerSessionKey) {
      throw new SubagentError(
        "INVALID_COMPLETION_OWNER",
        "Completion owner session key must not be empty",
      );
    }
    const ownerHash = createHash("sha256")
      .update(ownerSessionKey)
      .digest("hex")
      .slice(0, 24);
    return join(this.root, "consumers", `${consumer}-${ownerHash}.json`);
  }

  private validCursor(cursor: number): number {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new SubagentError(
        "INVALID_COMPLETION_CURSOR",
        `Invalid completion cursor: ${cursor}`,
      );
    }
    return cursor;
  }

  private async readCompletionCheckpoint(
    consumer: string,
    ownerSessionKey: string,
  ): Promise<{ cursor: number; offset: number }> {
    try {
      const checkpoint = JSON.parse(
        await readFile(this.consumerPath(consumer, ownerSessionKey), "utf8"),
      ) as { cursor: number; offset?: number };
      return {
        cursor: this.validCursor(checkpoint.cursor),
        offset:
          checkpoint.offset !== undefined &&
          Number.isSafeInteger(checkpoint.offset) &&
          checkpoint.offset >= 0
            ? checkpoint.offset
            : 0,
      };
    } catch (error: any) {
      if (error.code === "ENOENT") return { cursor: 0, offset: 0 };
      throw error;
    }
  }

  private async writeCompletionCheckpoint(
    consumer: string,
    ownerSessionKey: string,
    cursor: number,
    offset: number,
  ): Promise<void> {
    await atomicJson(this.consumerPath(consumer, ownerSessionKey), {
      version: 1,
      consumer,
      ownerSessionKey,
      cursor,
      offset,
    });
  }
  async readMeta(id: WorkerId | string): Promise<WorkerMeta> {
    return this.readJson(id, "meta.json");
  }
  async readState(id: WorkerId | string): Promise<WorkerState> {
    return this.readJson(id, "state.json");
  }
  async readResult(
    id: WorkerId | string,
    correlation?: { turn: number; resultSeq: number },
  ): Promise<WorkerResult | undefined> {
    if (correlation) {
      const { turn, resultSeq } = correlation;
      if (
        !Number.isSafeInteger(turn) ||
        turn < 0 ||
        !Number.isSafeInteger(resultSeq) ||
        resultSeq < 0
      ) {
        throw new SubagentError(
          "INVALID_RESULT_CORRELATION",
          "Result turn and resultSeq must be non-negative integers",
        );
      }
      try {
        return await this.readJson(
          id,
          `results/${turn}-${resultSeq}.json`,
        );
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try {
      const latest = await this.readJson<WorkerResult>(id, "result.json");
      if (!correlation) return latest;
      const latestSeq = latest.resultSeq ?? latest.eventSeq;
      return latest.turn === correlation.turn &&
        latestSeq === correlation.resultSeq
        ? latest
        : undefined;
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async readCompletion(
    id: WorkerId | string,
  ): Promise<WorkerCompletion | undefined> {
    try {
      return await this.readJson(id, "completion.json");
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async delete(id: WorkerId | string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
  private async readJson<T>(id: WorkerId | string, file: string): Promise<T> {
    return JSON.parse(await readFile(this.path(id, file), "utf8")) as T;
  }
  async readLogTail<T extends { seq: number }>(
    id: WorkerId | string,
    name: LogName,
    limit = 20,
    maxBytes = 64 * 1024,
  ): Promise<T[]> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new SubagentError("INVALID_ARGUMENT", "Tail limit must be positive");
    const path = this.path(id, `${name}.jsonl`);
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return text
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as T);
    } finally {
      await handle.close();
    }
  }

  async readLog<T extends { seq: number }>(
    id: WorkerId | string,
    name: LogName,
    fromSeq = 1,
    limit?: number,
    byteOffset?: number,
  ): Promise<T[]> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw new SubagentError(
        "INVALID_SEQUENCE",
        `Invalid fromSeq: ${fromSeq}. Expected a positive integer >= 1`,
      );
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new SubagentError(
        "INVALID_ARGUMENT",
        `Invalid limit: ${limit}. Expected a positive integer >= 1`,
      );
    }

    const filePath = this.path(id, `${name}.jsonl`);
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        try {
          await this.readMeta(id);
        } catch (metaErr: any) {
          if (metaErr?.code === "ENOENT") {
            throw new SubagentError(
              "WORKER_NOT_FOUND",
              `Worker not found: ${id}`,
            );
          }
        }
        return [];
      }
      throw error;
    }

    try {
      const stats = await handle.stat();
      const fileSize = stats.size;

      let startOffset = 0;
      if (byteOffset !== undefined && byteOffset >= 0 && byteOffset <= fileSize) {
        startOffset = byteOffset;
      } else if (name === "events" && fromSeq > 1) {
        try {
          const cached = await this.readState(id);
          if (
            cached.lastEventSeq + 1 === fromSeq &&
            typeof cached.lastEventOffset === "number" &&
            cached.lastEventOffset <= fileSize
          ) {
            startOffset = cached.lastEventOffset;
          }
        } catch {
          // ignore
        }
      }

      if (startOffset >= fileSize) {
        return [];
      }

      const readLen = fileSize - startOffset;
      const buffer = Buffer.alloc(readLen);
      await handle.read(buffer, 0, readLen, startOffset);
      const text = buffer.toString("utf8");

      const lines = text.split("\n");
      const output: T[] = [];
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (!line) continue;
        try {
          const record = JSON.parse(line) as T;
          if (record.seq >= fromSeq) {
            output.push(record);
            if (limit !== undefined && output.length >= limit) {
              break;
            }
          }
        } catch (error) {
          if (index === lines.length - 1 && !text.endsWith("\n")) break;
          throw new SubagentError(
            "CORRUPT_LOG",
            `Invalid ${name}.jsonl record ${index + 1}`,
            error,
          );
        }
      }
      for (let i = 0; i < output.length; i++) {
        if (output[i]!.seq !== fromSeq + i) {
          throw new SubagentError(
            "INVALID_SEQUENCE",
            `${name} sequence expected ${fromSeq + i}, got ${output[i]!.seq}`,
          );
        }
      }
      return output;
    } finally {
      await handle.close();
    }
  }
  async appendCommand(
    id: WorkerId | string,
    command:
      | { type: "prompt" | "send" | "steer"; text: string }
      | { type: "abort" | "stop" },
  ): Promise<WorkerCommand> {
    return this.append(id, "commands", command) as Promise<WorkerCommand>;
  }
  async appendEvent(
    id: WorkerId | string,
    event: Omit<WorkerEvent, "version" | "seq" | "at">,
  ): Promise<WorkerEvent> {
    return this.append(id, "events", event) as Promise<WorkerEvent>;
  }
  async withWorkerLock<T>(
    id: WorkerId | string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lock = this.path(id, ".worker.lock");
    const held = lockStorage.getStore();
    if (held?.has(lock)) {
      return await fn();
    }
    await this.acquire(lock);
    const nextHeld = new Set(held);
    nextHeld.add(lock);
    return await lockStorage.run(nextHeld, async () => {
      try {
        return await fn();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    });
  }
  async appendEventAndProjectState(
    id: WorkerId | string,
    value: Omit<WorkerEvent, "version" | "seq" | "at">,
  ): Promise<{ event: WorkerEvent; state: WorkerState }> {
    return this.withWorkerLock(id, async () => {
      const filePath = this.path(id, "events.jsonl");
      const lastSeq = await getLastSeqAndRepair(filePath);
      const record: WorkerEvent = {
        version: 1,
        seq: lastSeq + 1,
        at: new Date().toISOString(),
        ...value,
      };
      await appendFile(filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "a",
      });
      const endOffset = (await stat(filePath)).size;

      let cached: WorkerState;
      try {
        cached = await this.readState(id);
      } catch {
        cached = {
          version: 1,
          id: workerId(String(id)),
          status: "starting",
          turn: 0,
          lastCommandSeq: 0,
          lastEventSeq: 0,
        };
      }

      const unseenEvents = await this.readLog<WorkerEvent>(
        id,
        "events",
        cached.lastEventSeq + 1,
        undefined,
        cached.lastEventOffset,
      );

      const nextState = reduceEvents(cached, unseenEvents);
      nextState.lastEventOffset = endOffset;
      await this.writeState(nextState);

      return { event: record, state: nextState };
    });
  }
  private async append(
    id: WorkerId | string,
    name: LogName,
    value: object,
  ): Promise<unknown> {
    const lock = this.path(id, `.${name}.lock`);
    await this.acquire(lock);
    try {
      const filePath = this.path(id, `${name}.jsonl`);
      const lastSeq = await getLastSeqAndRepair(filePath);
      const record = {
        version: 1,
        seq: lastSeq + 1,
        at: new Date().toISOString(),
        ...value,
      };
      await appendFile(filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "a",
      });
      return record;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  private async acquire(lock: string): Promise<void> {
    const ownerFile = join(lock, "owner.json");
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        await mkdir(lock);
        try {
          await writeFile(
            ownerFile,
            JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
            { mode: 0o600 },
          );
        } catch {
          // best-effort write
        }
        return;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        try {
          let isStale = false;
          let validPid = false;
          try {
            const raw = await readFile(ownerFile, "utf8");
            const data = JSON.parse(raw);
            if (typeof data.pid === "number") {
              try {
                process.kill(data.pid, 0);
                validPid = true;
              } catch (killErr: any) {
                if (killErr.code === "EPERM") {
                  validPid = true;
                } else {
                  isStale = true;
                }
              }
            }
          } catch {
            /* ownerFile missing or unreadable */
          }
          if (!isStale && !validPid) {
            if (Date.now() - (await stat(lock)).mtimeMs > 10_000) {
              isStale = true;
            }
          }
          if (isStale) {
            await rm(lock, { recursive: true, force: true });
          }
        } catch {
          /* raced with lock owner */
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new SubagentError(
      "STORE_LOCK_TIMEOUT",
      `Timed out acquiring ${lock}`,
    );
  }
  async appendRunnerLog(id: WorkerId | string, text: string): Promise<void> {
    await appendFile(this.path(id, "runner.log"), text, "utf8");
  }
}
