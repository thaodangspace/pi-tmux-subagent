import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Recovery, type RecoveryOptions } from "./recovery.js";
import { ProtocolStore } from "../protocol/store.js";
import type { LaunchConfig, WorkerMeta, WorkerResult, WorkerState } from "../protocol/types.js";
import { TmuxAdapter } from "../tmux/adapter.js";
import { sessionName } from "../tmux/adapter.js";
import { SubagentError, workerId, type WorkerId } from "../types.js";
import { WorktreeAdapter } from "../worktree/adapter.js";

export interface ManagerOptions {
  store?: ProtocolStore;
  tmux?: TmuxAdapter;
  worktree?: WorktreeAdapter;
  runnerFile?: string;
  staleMs?: number;
  startupGraceMs?: number;
}

export class Manager {
  readonly store: ProtocolStore;
  readonly tmux: TmuxAdapter;
  readonly worktree: WorktreeAdapter;
  private readonly runnerFile: string;
  private readonly recoveryOptions: RecoveryOptions;

  constructor(options: ManagerOptions = {}) {
    this.store = options.store ?? new ProtocolStore();
    this.tmux = options.tmux ?? new TmuxAdapter();
    this.worktree = options.worktree ?? new WorktreeAdapter();
    this.runnerFile = options.runnerFile ?? resolve(dirname(fileURLToPath(import.meta.url)), "../runner/main.js");
    this.recoveryOptions = {
      ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
      ...(options.startupGraceMs !== undefined ? { startupGraceMs: options.startupGraceMs } : {}),
    };
  }

  async spawn(config: LaunchConfig, cwd = process.cwd(), requestedId?: string): Promise<WorkerState> {
    const parentDepth = process.env.PI_TMUX_DEPTH ? Number.parseInt(process.env.PI_TMUX_DEPTH, 10) : 0;
    const parentMaxDepth = process.env.PI_TMUX_MAX_DEPTH ? Number.parseInt(process.env.PI_TMUX_MAX_DEPTH, 10) : 1;
    const depth = config.depth ?? parentDepth;
    const maxDepth = config.maxDepth ?? parentMaxDepth;
    if (depth >= maxDepth) {
      throw new SubagentError("MAX_DEPTH_EXCEEDED", `Spawning depth limit reached (depth=${depth}, maxDepth=${maxDepth})`);
    }

    const id = workerId(requestedId ?? randomBytes(6).toString("hex"));
    const workspace = config.workspace === "worktree" ? await this.worktree.prepare(cwd, id) : { mode: "current" as const, root: cwd };
    const workerCwd = workspace.worktree ?? cwd;
    const launchConfig: LaunchConfig = {
      ...config,
      depth,
      maxDepth,
    };
    const meta: WorkerMeta = { version: 1, id, tmuxSession: sessionName(id), createdAt: new Date().toISOString(), cwd: workerCwd, launch: launchConfig, workspace };
    const state: WorkerState = { version: 1, id, status: "starting", turn: 0, lastCommandSeq: 0, lastEventSeq: 0 };
    await this.store.create(meta, state);
    await this.store.appendCommand(id, { type: "prompt", text: config.task });
    try {
      const childEnv: Record<string, string> = {
        PI_TMUX_DEPTH: String(depth + 1),
        PI_TMUX_MAX_DEPTH: String(maxDepth),
      };
      await this.tmux.create(id, this.store.dir(id), this.runnerFile, process.execPath, workerCwd, childEnv);
    } catch (error) {
      const event = await this.store.appendEvent(id, { type: "failed", data: error instanceof Error ? error.message : error });
      const failed = { ...state, status: "failed" as const, lastEventSeq: event.seq, lastEventAt: event.at };
      await this.store.writeState(failed);
      throw error;
    }
    return state;
  }

  async send(id: string, text: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "send", text })).seq; }
  async steer(id: string, text: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "steer", text })).seq; }
  async abort(id: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "abort" })).seq; }
  async stop(id: string): Promise<number> { return (await this.store.appendCommand(workerId(id), { type: "stop" })).seq; }
  status(id: string): Promise<WorkerState> { return new Recovery(this.store, this.tmux, this.recoveryOptions).recover(id); }
  result(id: string): Promise<WorkerResult | undefined> { return this.store.readResult(workerId(id)); }
  async list(): Promise<WorkerState[]> { return new Recovery(this.store, this.tmux, this.recoveryOptions).scan(); }
  async recover(id: string): Promise<WorkerState> { return new Recovery(this.store, this.tmux, this.recoveryOptions).recover(id); }
  attach(id: string): Promise<void> { return this.tmux.attach(workerId(id)); }
  async forceTerminate(id: string): Promise<void> { await this.tmux.terminate(workerId(id)); }
}
export type { WorkerId };
