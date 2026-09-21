import { readdir } from "node:fs/promises";
import { reduceEvents } from "../protocol/state.js";
import type { WorkerEvent, WorkerState } from "../protocol/types.js";
import { ProtocolStore } from "../protocol/store.js";
import { TmuxAdapter } from "../tmux/adapter.js";
import { workerId } from "../types.js";

// `completed` is accepted only for registries written by pre-persistent-worker
// versions. Current runners settle turns back to `waiting` and never emit it.
export const TERMINAL_WORKER_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "orphaned",
]);
function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RecoveryOptions {
  staleMs?: number;
  startupGraceMs?: number;
}

export class Recovery {
  private readonly staleMs: number;
  private readonly startupGraceMs: number;

  constructor(
    private readonly store: ProtocolStore,
    private readonly tmux: TmuxAdapter,
    staleMsOrOptions?: number | RecoveryOptions,
    startupGraceMs = 15_000,
  ) {
    if (typeof staleMsOrOptions === "object" && staleMsOrOptions !== null) {
      this.staleMs = staleMsOrOptions.staleMs ?? 10_000;
      this.startupGraceMs = staleMsOrOptions.startupGraceMs ?? 15_000;
    } else {
      this.staleMs = staleMsOrOptions ?? 10_000;
      this.startupGraceMs = startupGraceMs;
    }
  }

  async scan(): Promise<WorkerState[]> {
    let ids: string[];
    try {
      ids = await readdir(this.store.root);
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const states = await Promise.all(
      ids
        .filter((id) => /^[a-z0-9][a-z0-9-]{2,47}$/.test(id))
        .map((id) => this.recover(id).catch(() => undefined)),
    );
    return states
      .filter((x): x is WorkerState => Boolean(x))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async recover(value: string): Promise<WorkerState> {
    const id = workerId(value);
    const [meta, cached, events] = await Promise.all([
      this.store.readMeta(id),
      this.store.readState(id),
      this.store.readLog<WorkerEvent>(id, "events"),
    ]);
    let state = reduceEvents(
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

    const isStarting = state.status === "starting";
    const startupGraceActive =
      isStarting && meta.createdAt
        ? !Number.isNaN(Date.parse(meta.createdAt)) &&
          Date.now() - Date.parse(meta.createdAt) <= this.startupGraceMs
        : false;

    if (!TERMINAL_WORKER_STATUSES.has(state.status) && !startupGraceActive) {
      const fresh = meta.heartbeatAt
        ? Date.now() - Date.parse(meta.heartbeatAt) <= this.staleMs
        : false;
      const session = await this.tmux.exists(id).catch(() => false);
      if (!fresh || !session || !alive(meta.runnerPid) || !alive(meta.piPid)) {
        const reasons = {
          session,
          heartbeatFresh: fresh,
          runnerAlive: alive(meta.runnerPid),
          piAlive: alive(meta.piPid),
        };
        const event = await this.store.appendEvent(id, {
          type: "orphaned",
          data: reasons,
        });
        state = reduceEvents(state, [event]);
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(cached))
      await this.store.writeState(state);
    return state;
  }
}
