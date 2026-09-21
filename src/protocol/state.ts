import type { WorkerEvent, WorkerState } from "./types.js";

const STRICT_TERMINAL_STATUSES = new Set([
  "stopped",
  "failed",
  "killed",
  "completed",
]);

export function reduceEvents(
  initial: WorkerState,
  events: readonly WorkerEvent[],
): WorkerState {
  return events.reduce(
    (state, event) => {
      const next = { ...state, lastEventSeq: event.seq, lastEventAt: event.at };
      if (event.type === "command_ack" && event.commandSeq) {
        next.lastCommandSeq = Math.max(next.lastCommandSeq, event.commandSeq);
      }

      // Terminal workers (stopped, failed, killed, completed) cannot be revived by ordinary events
      if (STRICT_TERMINAL_STATUSES.has(state.status)) {
        return next;
      }

      // Orphaned workers can only be revived via explicit recovery (liveness_recovered) or become killed/failed/stopped
      if (state.status === "orphaned") {
        if (event.type === "liveness_recovered") {
          next.status = "waiting";
          delete next.error;
        } else if (event.type === "killed") {
          next.status = "killed";
        } else if (event.type === "failed" || event.type === "rpc_exit") {
          next.status = "failed";
          next.error =
            typeof event.data === "string"
              ? event.data
              : JSON.stringify(event.data);
        } else if (event.type === "stopped") {
          next.status = "stopped";
        }
        return next;
      }

      if (event.type === "rpc_started") {
        next.status = "waiting";
        delete next.error;
      } else if (event.type === "liveness_recovered") {
        next.status = "waiting";
        delete next.error;
      } else if (event.type === "agent_start") {
        next.status = "running";
        next.turn += 1;
        const turnContext = (event.data as {
          turnContext?: { initiatingCommandSeq?: number };
        } | undefined)?.turnContext;
        const initiatingCommandSeq =
          turnContext?.initiatingCommandSeq ?? event.commandSeq;
        next.activeTurn = {
          turn: next.turn,
          ...(initiatingCommandSeq !== undefined
            ? { initiatingCommandSeq }
            : {}),
        };
      } else if (event.type === "agent_settled") {
        next.status = "waiting";
        delete next.activeTurn;
      } else if (event.type === "stopped") {
        next.status = "stopped";
      } else if (event.type === "killed") {
        next.status = "killed";
      } else if (event.type === "orphaned") {
        next.status = "orphaned";
      } else if (event.type === "unresponsive") {
        next.status = "unresponsive";
      } else if (event.type === "responsive") {
        next.status = "running";
      } else if (event.type === "failed" || event.type === "rpc_exit") {
        next.status = "failed";
        next.error =
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data);
      }
      return next;
    },
    { ...initial },
  );
}
