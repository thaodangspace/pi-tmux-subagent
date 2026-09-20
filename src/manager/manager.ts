import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Recovery } from "./recovery.js";
import { ProtocolStore } from "../protocol/store.js";
import type { LaunchConfig, WorkerMeta, WorkerResult, WorkerState } from "../protocol/types.js";
import { TmuxAdapter } from "../tmux/adapter.js";
import { sessionName } from "../tmux/adapter.js";
import { workerId, type WorkerId } from "../types.js";
import { WorktreeAdapter } from "../worktree/adapter.js";

export interface ManagerOptions { store?: ProtocolStore; tmux?: TmuxAdapter; worktree?: WorktreeAdapter; runnerFile?: string }
export class Manager {
  readonly store: ProtocolStore; readonly tmux: TmuxAdapter; readonly worktree: WorktreeAdapter; private readonly runnerFile: string;
  constructor(options: ManagerOptions = {}) {
    this.store = options.store ?? new ProtocolStore(); this.tmux = options.tmux ?? new TmuxAdapter(); this.worktree = options.worktree ?? new WorktreeAdapter();
    this.runnerFile = options.runnerFile ?? resolve(dirname(fileURLToPath(import.meta.url)), "../runner/main.js");
  }
  async spawn(config: LaunchConfig, cwd = process.cwd(), requestedId?: string): Promise<WorkerState> {
    const id = workerId(requestedId ?? randomBytes(6).toString("hex"));
    const workspace = config.workspace === "worktree" ? await this.worktree.prepare(cwd, id) : { mode: "current" as const, root: cwd };
    const workerCwd = workspace.worktree ?? cwd;
    const meta: WorkerMeta = { version: 1, id, tmuxSession: sessionName(id), createdAt: new Date().toISOString(), cwd: workerCwd, launch: config, workspace };
    const state: WorkerState = { version: 1, id, status: "starting", turn: 0, lastCommandSeq: 0, lastEventSeq: 0 };
    await this.store.create(meta, state); await this.store.appendCommand(id, { type: "prompt", text: config.task });
    try { await this.tmux.create(id, this.store.dir(id), this.runnerFile, process.execPath, workerCwd); } catch (error) {
      const event = await this.store.appendEvent(id, { type: "failed", data: error instanceof Error ? error.message : error });
      const failed = { ...state, status: "failed" as const, lastEventSeq: event.seq, lastEventAt: event.at }; await this.store.writeState(failed); throw error;
    }
    return state;
  }
  async send(id: string, text: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "send", text })).seq; }
  async steer(id: string, text: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "steer", text })).seq; }
  async abort(id: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "abort" })).seq; }
  async stop(id: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "stop" })).seq; }
  status(id: string): Promise<WorkerState> { return new Recovery(this.store, this.tmux).recover(id); }
  result(id: string): Promise<WorkerResult | undefined> { return this.store.readResult(workerId(id)); }
  async list(): Promise<WorkerState[]> { return new Recovery(this.store, this.tmux).scan(); }
  async recover(id: string): Promise<WorkerState> { return new Recovery(this.store, this.tmux).recover(id); }
  attach(id: string): Promise<void> { return this.tmux.attach(workerId(id)); }
  async forceTerminate(id: string): Promise<void> { await this.tmux.terminate(workerId(id)); }
}
export type { WorkerId };
