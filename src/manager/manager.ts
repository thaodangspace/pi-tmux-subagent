import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Recovery, type RecoveryOptions } from "./recovery.js";
import { ProtocolStore } from "../protocol/store.js";
import { completionSummary } from "../protocol/completion.js";
import type {
  CompletionFeedEntry,
  CompletionQuery,
  EventHistoryOptions,
  LaunchConfig,
  WorkerCompletion,
  WorkerEvent,
  WorkerEventsResult,
  WorkerMeta,
  WorkerResult,
  WorkerState,
} from "../protocol/types.js";
import { TmuxAdapter } from "../tmux/adapter.js";
import { sessionName } from "../tmux/adapter.js";
import { SubagentError, workerId, type WorkerId } from "../types.js";
import { WorktreeAdapter } from "../worktree/adapter.js";

export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 100;
export const MAX_EVENT_BYTES = 40_000;

export interface ManagerOptions {
  store?: ProtocolStore;
  tmux?: TmuxAdapter;
  worktree?: WorktreeAdapter;
  runnerFile?: string;
  staleMs?: number;
  startupGraceMs?: number;
  orphanGraceMs?: number;
  defaultEventLimit?: number;
  maxEventLimit?: number;
  maxEventBytes?: number;
}

export class Manager {
  readonly store: ProtocolStore;
  readonly tmux: TmuxAdapter;
  readonly worktree: WorktreeAdapter;
  readonly defaultEventLimit: number;
  readonly maxEventLimit: number;
  readonly maxEventBytes: number;
  private readonly runnerFile: string;
  private readonly recoveryOptions: RecoveryOptions;

  constructor(options: ManagerOptions = {}) {
    this.store = options.store ?? new ProtocolStore();
    this.tmux = options.tmux ?? new TmuxAdapter();
    this.worktree = options.worktree ?? new WorktreeAdapter();
    this.defaultEventLimit = options.defaultEventLimit ?? DEFAULT_EVENT_LIMIT;
    this.maxEventLimit = options.maxEventLimit ?? MAX_EVENT_LIMIT;
    this.maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
    this.runnerFile =
      options.runnerFile ??
      resolve(dirname(fileURLToPath(import.meta.url)), "../runner/main.js");
    this.recoveryOptions = {
      ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
      ...(options.startupGraceMs !== undefined
        ? { startupGraceMs: options.startupGraceMs }
        : {}),
      ...(options.orphanGraceMs !== undefined
        ? { orphanGraceMs: options.orphanGraceMs }
        : {}),
    };
  }

  async spawn(
    config: LaunchConfig,
    cwd = process.cwd(),
    requestedId?: string,
    ownerSessionKey?: string,
  ): Promise<WorkerState> {
    const parentDepth = process.env.PI_TMUX_DEPTH
      ? Number.parseInt(process.env.PI_TMUX_DEPTH, 10)
      : 0;
    const parentMaxDepth = process.env.PI_TMUX_MAX_DEPTH
      ? Number.parseInt(process.env.PI_TMUX_MAX_DEPTH, 10)
      : 1;
    const depth = config.depth ?? parentDepth;
    const maxDepth = config.maxDepth ?? parentMaxDepth;
    if (depth >= maxDepth) {
      throw new SubagentError(
        "MAX_DEPTH_EXCEEDED",
        `Spawning depth limit reached (depth=${depth}, maxDepth=${maxDepth})`,
      );
    }

    const id = workerId(requestedId ?? randomBytes(6).toString("hex"));
    const workspace =
      config.workspace === "worktree"
        ? await this.worktree.prepare(cwd, id)
        : { mode: "current" as const, root: cwd };
    const workerCwd = workspace.worktree ?? cwd;
    const launchConfig: LaunchConfig = {
      ...config,
      depth,
      maxDepth,
    };
    const meta: WorkerMeta = {
      version: 1,
      id,
      ...(ownerSessionKey ? { ownerSessionKey } : {}),
      tmuxSession: sessionName(id),
      createdAt: new Date().toISOString(),
      cwd: workerCwd,
      launch: launchConfig,
      workspace,
    };
    const state: WorkerState = {
      version: 1,
      id,
      status: "starting",
      turn: 0,
      lastCommandSeq: 0,
      lastEventSeq: 0,
    };
    let registered = false;
    try {
      await this.store.create(meta, state);
      registered = true;
      await this.store.appendCommand(id, { type: "prompt", text: config.task });
      try {
        const childEnv: Record<string, string> = {
          PI_TMUX_DEPTH: String(depth + 1),
          PI_TMUX_MAX_DEPTH: String(maxDepth),
        };
        await this.tmux.create(
          id,
          this.store.dir(id),
          this.runnerFile,
          process.execPath,
          workerCwd,
          childEnv,
        );
      } catch (error) {
        const { event, state: failed } = await this.store.appendEventAndProjectState(id, {
          type: "failed",
          data: error instanceof Error ? error.message : error,
        });
        await this.store.writeResult({
          version: 1,
          id,
          status: "failed",
          turn: failed.turn,
          commandSeq: 1,
          resultSeq: event.seq,
          eventSeq: event.seq,
          text: error instanceof Error ? error.message : String(error),
          completedAt: event.at,
          workspace,
        });
        await this.store.writeCompletion({
          version: 1,
          kind: "turn",
          id,
          turn: failed.turn,
          commandSeq: 1,
          resultSeq: event.seq,
          status: "failed",
          summary: completionSummary(
            error instanceof Error ? error.message : String(error),
          ),
          hasDetails: true,
          completedAt: event.at,
        });
        throw error;
      }
    } catch (error) {
      if (!registered && workspace.mode === "worktree") {
        await this.worktree.cleanup(workspace).catch(() => undefined);
      }
      throw error;
    }
    return state;
  }

  async send(id: string, text: string): Promise<number> {
    return (
      await this.store.appendCommand(workerId(id), { type: "send", text })
    ).seq;
  }
  async steer(id: string, text: string): Promise<number> {
    return (
      await this.store.appendCommand(workerId(id), { type: "steer", text })
    ).seq;
  }
  async abort(id: string): Promise<number> {
    return (await this.store.appendCommand(workerId(id), { type: "abort" }))
      .seq;
  }
  async stop(id: string): Promise<number> {
    return (await this.store.appendCommand(workerId(id), { type: "stop" })).seq;
  }
  status(id: string): Promise<WorkerState> {
    return new Recovery(this.store, this.tmux, this.recoveryOptions).recover(
      id,
    );
  }
  async result(
    id: string,
    correlation?: { turn: number; resultSeq: number },
  ): Promise<WorkerResult | undefined> {
    const res = await this.store.readResult(workerId(id), correlation);
    if (!res) return undefined;
    return {
      ...res,
      resultSeq: res.resultSeq ?? res.eventSeq,
    };
  }
  async getResult(
    id: string,
    correlation?: { turn: number; resultSeq: number },
  ): Promise<WorkerResult> {
    const value = workerId(id);
    try {
      await this.store.readMeta(value);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new SubagentError(
          "WORKER_NOT_FOUND",
          `Worker not found: ${value}`,
        );
      }
      throw error;
    }
    const result = await this.result(value, correlation);
    if (!result) {
      if (correlation) {
        throw new SubagentError(
          "RESULT_CORRELATION_NOT_FOUND",
          `No result for worker ${value} at turn ${correlation.turn}, resultSeq ${correlation.resultSeq}`,
        );
      }
      throw new SubagentError(
        "RESULT_NOT_FOUND",
        `No result available for worker: ${value}`,
      );
    }
    return result;
  }
  async events(
    id: string,
    options: EventHistoryOptions = {},
  ): Promise<WorkerEventsResult> {
    const value = workerId(id);
    try {
      await this.store.readMeta(value);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new SubagentError(
          "WORKER_NOT_FOUND",
          `Worker not found: ${value}`,
        );
      }
      throw error;
    }

    const fromSeq = options.fromSeq ?? 1;
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw new SubagentError(
        "INVALID_SEQUENCE",
        `Invalid fromSeq: ${options.fromSeq}. Expected a positive integer >= 1`,
      );
    }

    let limit = this.defaultEventLimit;
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
        throw new SubagentError(
          "INVALID_ARGUMENT",
          `Invalid limit: ${options.limit}. Expected a positive integer >= 1`,
        );
      }
      limit = Math.min(options.limit, this.maxEventLimit);
    }

    const records = await this.store.readLog<WorkerEvent>(
      value,
      "events",
      fromSeq,
      limit + 1,
    );

    let accumulatedBytes = 0;
    const selectedEvents: WorkerEvent[] = [];
    let hasMore = false;
    let nextSeq: number | undefined;

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (selectedEvents.length >= limit) {
        hasMore = true;
        nextSeq = record.seq;
        break;
      }
      const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (
        selectedEvents.length > 0 &&
        accumulatedBytes + recordBytes > this.maxEventBytes
      ) {
        hasMore = true;
        nextSeq = record.seq;
        break;
      }
      selectedEvents.push(record);
      accumulatedBytes += recordBytes;
    }

    return {
      version: 1,
      id: value,
      events: selectedEvents,
      fromSeq,
      ...(nextSeq !== undefined ? { nextSeq } : {}),
      hasMore,
    };
  }
  completion(id: string): Promise<WorkerCompletion | undefined> {
    return this.store.readCompletion(workerId(id));
  }
  /** Returns entries after an explicit cursor or the consumer's durable ack. */
  completions(query: CompletionQuery): Promise<CompletionFeedEntry[]> {
    return this.store.completions(query);
  }
  /** Advance a consumer checkpoint only after it handled the entry. */
  ackCompletion(
    consumer: string,
    ownerSessionKey: string,
    cursor: number,
  ): Promise<void> {
    return this.store.ackCompletion(consumer, ownerSessionKey, cursor);
  }
  async list(): Promise<WorkerState[]> {
    return new Recovery(this.store, this.tmux, this.recoveryOptions).scan();
  }
  async recover(id: string): Promise<WorkerState> {
    return new Recovery(this.store, this.tmux, this.recoveryOptions).recover(
      id,
    );
  }
  async delete(id: string): Promise<void> {
    const value = workerId(id);
    const state = await this.status(value);
    if (
      // `completed` is a legacy terminal snapshot. Persistent workers now
      // return to `waiting` whenever a turn settles.
      state.status !== "completed" &&
      state.status !== "failed" &&
      state.status !== "stopped" &&
      state.status !== "killed" &&
      state.status !== "orphaned"
    ) {
      throw new SubagentError(
        "WORKER_ACTIVE",
        `Cannot delete active worker ${value} (${state.status}); stop it first`,
      );
    }
    const meta = await this.store.readMeta(value);
    if (meta.workspace?.mode === "worktree") {
      // Cleanup runs before registry deletion. DIRTY_WORKTREE leaves metadata
      // intact so the user never loses the recovery pointer.
      await this.worktree.cleanup(meta.workspace);
    }
    await this.tmux.terminate(value).catch(() => undefined);
    await this.store.delete(value);
  }
  attach(id: string): Promise<void> {
    return this.tmux.attach(workerId(id));
  }
  async forceTerminate(id: string): Promise<WorkerState> {
    const value = workerId(id);
    return this.store.withWorkerLock(value, async () => {
      const meta = await this.store.readMeta(value).catch(() => undefined);
      // tmux termination kills the tagged pane or standalone session and its
      // supervised runner/RPC process tree. The adapter treats absence as safe.
      await this.tmux.terminate(value);
      const current = await this.store.readState(value);
      if (current.status === "killed") return current;

      const wasActiveTurn = current.status === "running" || current.status === "unresponsive";
      const events = current.activeTurn
        ? []
        : await this.store.readLog<WorkerEvent>(value, "events").catch(() => []);
      const lastAgentStart = [...events].reverse().find((e) => e.type === "agent_start");
      const initiatingCmdSeq =
        current.activeTurn?.initiatingCommandSeq ??
        (lastAgentStart?.data as any)?.turnContext?.initiatingCommandSeq ??
        lastAgentStart?.commandSeq ??
        (current.lastCommandSeq > 0 ? current.lastCommandSeq : undefined);

      const { event, state: killed } = await this.store.appendEventAndProjectState(value, {
        type: "killed",
        data: "Force-terminated by supervisor",
      });

      if (wasActiveTurn) {
        const result: WorkerResult = {
          version: 1,
          id: value,
          status: "failed",
          turn: killed.turn,
          ...(initiatingCmdSeq !== undefined ? { commandSeq: initiatingCmdSeq } : {}),
          resultSeq: event.seq,
          eventSeq: event.seq,
          text: "Force-terminated by supervisor",
          completedAt: event.at,
          ...(meta?.workspace ? { workspace: meta.workspace } : {}),
        };
        await this.store.writeResult(result);
        await this.store.writeCompletion({
          version: 1,
          kind: "turn",
          id: value,
          turn: killed.turn,
          ...(initiatingCmdSeq !== undefined ? { commandSeq: initiatingCmdSeq } : {}),
          resultSeq: event.seq,
          status: "failed",
          summary: completionSummary("Force-terminated by supervisor"),
          hasDetails: true,
          completedAt: event.at,
        });
      } else {
        // Idle worker force-termination: do NOT overwrite previous turn result!
        await this.store.writeCompletion({
          version: 1,
          kind: "worker",
          id: value,
          turn: killed.turn,
          resultSeq: event.seq,
          status: "failed",
          summary: completionSummary("Force-terminated by supervisor"),
          hasDetails: false,
          completedAt: event.at,
        });
      }
      return killed;
    });
  }
}
export type { WorkerId };
