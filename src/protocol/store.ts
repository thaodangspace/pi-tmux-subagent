import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { SubagentError, workerId, type WorkerId } from "../types.js";
import type { WorkerCommand, WorkerEvent, WorkerMeta, WorkerResult, WorkerState } from "./types.js";

export const DEFAULT_REGISTRY_ROOT = join(homedir(), ".pi", "tmux-subagents");
export type LogName = "commands" | "events";

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export class ProtocolStore {
  constructor(readonly root = DEFAULT_REGISTRY_ROOT) {}
  dir(id: WorkerId | string): string { return join(this.root, workerId(String(id))); }
  path(id: WorkerId | string, name: string): string { return join(this.dir(id), name); }
  async create(meta: WorkerMeta, state: WorkerState): Promise<void> {
    const dir = this.dir(meta.id);
    try { await mkdir(dir, { recursive: false, mode: 0o700 }); } catch (error: any) {
      if (error.code === "EEXIST") throw new SubagentError("WORKER_EXISTS", `Worker already exists: ${meta.id}`);
      throw error;
    }
    await Promise.all([writeFile(join(dir, "commands.jsonl"), "", { mode: 0o600 }), writeFile(join(dir, "events.jsonl"), "", { mode: 0o600 })]);
    await this.writeMeta(meta); await this.writeState(state);
  }
  async writeMeta(value: WorkerMeta): Promise<void> { await atomicJson(this.path(value.id, "meta.json"), value); }
  async writeState(value: WorkerState): Promise<void> { await atomicJson(this.path(value.id, "state.json"), value); }
  async writeResult(value: WorkerResult): Promise<void> { await atomicJson(this.path(value.id, "result.json"), value); }
  async readMeta(id: WorkerId | string): Promise<WorkerMeta> { return this.readJson(id, "meta.json"); }
  async readState(id: WorkerId | string): Promise<WorkerState> { return this.readJson(id, "state.json"); }
  async readResult(id: WorkerId | string): Promise<WorkerResult | undefined> { try { return await this.readJson(id, "result.json"); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; } }
  private async readJson<T>(id: WorkerId | string, file: string): Promise<T> { return JSON.parse(await readFile(this.path(id, file), "utf8")) as T; }
  async readLog<T extends { seq: number }>(id: WorkerId | string, name: LogName): Promise<T[]> {
    const text = await readFile(this.path(id, `${name}.jsonl`), "utf8");
    const lines = text.split("\n"); const output: T[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!; if (!line) continue;
      try { output.push(JSON.parse(line) as T); }
      catch (error) { if (index === lines.length - 1 && !text.endsWith("\n")) break; throw new SubagentError("CORRUPT_LOG", `Invalid ${name}.jsonl record ${index + 1}`, error); }
    }
    for (let i = 0; i < output.length; i++) if (output[i]!.seq !== i + 1) throw new SubagentError("INVALID_SEQUENCE", `${name} sequence expected ${i + 1}, got ${output[i]!.seq}`);
    return output;
  }
  async appendCommand(id: WorkerId | string, command: { type: "prompt" | "send" | "steer"; text: string } | { type: "abort" | "stop" }): Promise<WorkerCommand> { return this.append(id, "commands", command) as Promise<WorkerCommand>; }
  async appendEvent(id: WorkerId | string, event: Omit<WorkerEvent, "version" | "seq" | "at">): Promise<WorkerEvent> { return this.append(id, "events", event) as Promise<WorkerEvent>; }
  private async append(id: WorkerId | string, name: LogName, value: object): Promise<unknown> {
    const lock = this.path(id, `.${name}.lock`); await this.acquire(lock);
    try {
      const records = await this.readLog<{ seq: number }>(id, name);
      const record = { version: 1, seq: records.length + 1, at: new Date().toISOString(), ...value };
      await appendFile(this.path(id, `${name}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
      return record;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async acquire(lock: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock); return; } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true }); } catch { /* raced with lock owner */ }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new SubagentError("STORE_LOCK_TIMEOUT", `Timed out acquiring ${lock}`);
  }
  async appendRunnerLog(id: WorkerId | string, text: string): Promise<void> { await appendFile(this.path(id, "runner.log"), text, "utf8"); }
}
