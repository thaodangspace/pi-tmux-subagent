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
import { randomUUID } from "node:crypto";
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
  constructor(readonly root = DEFAULT_REGISTRY_ROOT) {}
  dir(id: WorkerId | string): string {
    return join(this.root, workerId(String(id)));
  }
  path(id: WorkerId | string, name: string): string {
    return join(this.dir(id), name);
  }
  async create(meta: WorkerMeta, state: WorkerState): Promise<void> {
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
    await atomicJson(this.path(value.id, "result.json"), value);
  }
  async writeCompletion(value: WorkerCompletion): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, ".completions.lock");
    await this.acquire(lock);
    try {
      const feedPath = join(this.root, "completions.jsonl");
      const lastCursor = await getLastSeqAndRepair(feedPath);
      const entries = await this.readCompletionFeed();
      const existing = entries.find(
        ({ completion }) =>
          completion.id === value.id &&
          completion.turn === value.turn &&
          completion.resultSeq === value.resultSeq &&
          completion.status === value.status,
      );
      if (!existing) {
        const entry: CompletionFeedEntry = {
          version: 1,
          cursor: lastCursor + 1,
          completion: value,
        };
        await appendFile(feedPath, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          flag: "a",
          mode: 0o600,
        });
      }
      // The per-worker file is only a latest-completion cache. The feed above
      // is the durable history and must be published first.
      await atomicJson(this.path(value.id, "completion.json"), value);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async completions(query: CompletionQuery): Promise<CompletionFeedEntry[]> {
    this.consumerPath(query.consumer);
    const after =
      query.after === undefined
        ? await this.readCompletionCursor(query.consumer)
        : this.validCursor(query.after);
    return (await this.readCompletionFeed()).filter(
      (entry) => entry.cursor > after,
    );
  }

  async ackCompletion(consumer: string, cursor: number): Promise<void> {
    const value = this.validCursor(cursor);
    const cursorPath = this.consumerPath(consumer);
    const lock = `${cursorPath}.lock`;
    await mkdir(dirname(cursorPath), { recursive: true, mode: 0o700 });
    await this.acquire(lock);
    try {
      const entries = await this.readCompletionFeed();
      const maximum = entries.at(-1)?.cursor ?? 0;
      if (value > maximum) {
        throw new SubagentError(
          "INVALID_COMPLETION_CURSOR",
          `Completion cursor ${value} has not been published`,
        );
      }
      const current = await this.readCompletionCursor(consumer);
      if (value > current) {
        await atomicJson(cursorPath, { version: 1, consumer, cursor: value });
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
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
        entries.push(entry);
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

  private consumerPath(consumer: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(consumer)) {
      throw new SubagentError(
        "INVALID_COMPLETION_CONSUMER",
        `Invalid completion consumer: ${consumer}`,
      );
    }
    return join(this.root, "consumers", `${consumer}.json`);
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

  private async readCompletionCursor(consumer: string): Promise<number> {
    try {
      const checkpoint = JSON.parse(
        await readFile(this.consumerPath(consumer), "utf8"),
      ) as { cursor: number };
      return this.validCursor(checkpoint.cursor);
    } catch (error: any) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }
  async readMeta(id: WorkerId | string): Promise<WorkerMeta> {
    return this.readJson(id, "meta.json");
  }
  async readState(id: WorkerId | string): Promise<WorkerState> {
    return this.readJson(id, "state.json");
  }
  async readResult(id: WorkerId | string): Promise<WorkerResult | undefined> {
    try {
      return await this.readJson(id, "result.json");
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
  async readLog<T extends { seq: number }>(
    id: WorkerId | string,
    name: LogName,
    fromSeq = 1,
  ): Promise<T[]> {
    const text = await readFile(this.path(id, `${name}.jsonl`), "utf8");
    const lines = text.split("\n");
    const output: T[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line) continue;
      try {
        const record = JSON.parse(line) as T;
        if (record.seq >= fromSeq) {
          output.push(record);
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
    for (let i = 0; i < output.length; i++)
      if (output[i]!.seq !== fromSeq + i)
        throw new SubagentError(
          "INVALID_SEQUENCE",
          `${name} sequence expected ${fromSeq + i}, got ${output[i]!.seq}`,
        );
    return output;
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
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(lock);
        return;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > 30_000)
            await rm(lock, { recursive: true, force: true });
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
