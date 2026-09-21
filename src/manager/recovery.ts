import { readdir } from "node:fs/promises";
import { completionSummary } from "../protocol/completion.js";
import { reduceEvents } from "../protocol/state.js";
import type {
  WorkerEvent,
  WorkerResult,
  WorkerState,
} from "../protocol/types.js";
import { ProtocolStore } from "../protocol/store.js";
import { TmuxAdapter } from "../tmux/adapter.js";
import { workerId } from "../types.js";

// `completed` is accepted only for registries written by pre-persistent-worker
// versions. Current runners settle turns back to `waiting` and never emit it.
export const TERMINAL_WORKER_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
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
  /** Continuous authoritative probe failure required before orphaning. */
  orphanGraceMs?: number;
}

export class Recovery {
  private readonly staleMs: number;
  private readonly startupGraceMs: number;
  private readonly orphanGraceMs: number;

  constructor(
    private readonly store: ProtocolStore,
    private readonly tmux: TmuxAdapter,
    staleMsOrOptions?: number | RecoveryOptions,
    startupGraceMs = 15_000,
  ) {
    if (typeof staleMsOrOptions === "object" && staleMsOrOptions !== null) {
      this.staleMs = staleMsOrOptions.staleMs ?? 10_000;
      this.startupGraceMs = staleMsOrOptions.startupGraceMs ?? 15_000;
      this.orphanGraceMs = staleMsOrOptions.orphanGraceMs ?? this.staleMs;
    } else {
      this.staleMs = staleMsOrOptions ?? 10_000;
      this.startupGraceMs = startupGraceMs;
      this.orphanGraceMs = this.staleMs;
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
    const [meta, cached] = await Promise.all([
      this.store.readMeta(id),
      this.store.readState(id).catch(() => undefined),
    ]);

    let state: WorkerState;
    let newEvents: WorkerEvent[] = [];
    if (cached && cached.lastEventSeq > 0) {
      try {
        newEvents = await this.store.readLog<WorkerEvent>(
          id,
          "events",
          cached.lastEventSeq + 1,
        );
        state = reduceEvents(cached, newEvents);
      } catch {
        const events = await this.store.readLog<WorkerEvent>(id, "events");
        state = reduceEvents(
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
      }
    } else {
      const events = await this.store.readLog<WorkerEvent>(id, "events");
      state = reduceEvents(
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
    }

    const isStarting = state.status === "starting";
    const startupGraceActive =
      isStarting && meta.createdAt
        ? !Number.isNaN(Date.parse(meta.createdAt)) &&
          Date.now() - Date.parse(meta.createdAt) <= this.startupGraceMs
        : false;

    const fresh = meta.heartbeatAt
      ? Date.now() - Date.parse(meta.heartbeatAt) <= this.staleMs
      : false;
    const session = await this.tmux.exists(id).catch(() => false);
    const runnerAlive = alive(meta.runnerPid);
    const piAlive = alive(meta.piPid);
    const demonstrablyAlive = session && runnerAlive && fresh;

    if (state.status === "orphaned" && demonstrablyAlive) {
      const event = await this.store.appendEvent(id, {
        type: "liveness_recovered",
        data: { session, heartbeatFresh: fresh, runnerAlive, piAlive },
      });
      state = reduceEvents(state, [event]);
    } else if (
      !TERMINAL_WORKER_STATUSES.has(state.status) &&
      !startupGraceActive
    ) {
      // Tagged tmux ownership plus the runner PID are authoritative. Heartbeat
      // and child-Pi probes are advisory while both supervisor signals agree.
      const authoritativeFailure = !session || !runnerAlive;
      const recentEvents = await this.store
        .readLogTail<WorkerEvent>(id, "events", 20)
        .catch(() => newEvents);
      const lastEvidence = [...recentEvents]
        .reverse()
        .find(
          (event) =>
            event.type === "liveness_suspected" ||
            event.type === "liveness_recovered" ||
            event.type === "rpc_started",
        );
      const suspect =
        lastEvidence?.type === "liveness_suspected" ? lastEvidence : undefined;

      const publishOrphanedFailure = async (orphanedEvent: WorkerEvent) => {
        const failureText = "Worker process terminated unexpectedly (orphaned)";
        const result: WorkerResult = {
          version: 1,
          id,
          status: "failed",
          turn: state.turn,
          ...(state.lastCommandSeq ? { commandSeq: state.lastCommandSeq } : {}),
          resultSeq: orphanedEvent.seq,
          eventSeq: orphanedEvent.seq,
          text: failureText,
          completedAt: state.lastEventAt ?? new Date().toISOString(),
          ...(meta.workspace ? { workspace: meta.workspace } : {}),
        };
        await this.store.writeResult(result);
        await this.store.writeCompletion({
          version: 1,
          id,
          turn: state.turn,
          ...(state.lastCommandSeq ? { commandSeq: state.lastCommandSeq } : {}),
          resultSeq: orphanedEvent.seq,
          status: "failed",
          summary: completionSummary(failureText),
          hasDetails: true,
          completedAt: state.lastEventAt ?? new Date().toISOString(),
        });
      };

      if (!authoritativeFailure && suspect) {
        const event = await this.store.appendEvent(id, {
          type: "liveness_recovered",
          data: { session, heartbeatFresh: fresh, runnerAlive, piAlive },
        });
        state = reduceEvents(state, [event]);
      } else if (authoritativeFailure && !suspect) {
        const event = await this.store.appendEvent(id, {
          type: "liveness_suspected",
          data: { session, heartbeatFresh: fresh, runnerAlive, piAlive },
        });
        state = reduceEvents(state, [event]);
        if (this.orphanGraceMs === 0) {
          const orphaned = await this.store.appendEvent(id, {
            type: "orphaned",
            data: event.data,
          });
          state = reduceEvents(state, [orphaned]);
          await publishOrphanedFailure(orphaned);
        }
      } else if (
        authoritativeFailure &&
        suspect &&
        Date.now() - Date.parse(suspect.at) >= this.orphanGraceMs
      ) {
        const event = await this.store.appendEvent(id, {
          type: "orphaned",
          data: { session, heartbeatFresh: fresh, runnerAlive, piAlive },
        });
        state = reduceEvents(state, [event]);
        await publishOrphanedFailure(event);
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(cached))
      await this.store.writeState(state);
    return state;
  }
}
