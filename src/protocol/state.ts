import type { WorkerEvent, WorkerState } from "./types.js";

export function reduceEvents(
  initial: WorkerState,
  events: readonly WorkerEvent[],
): WorkerState {
  return events.reduce(
    (state, event) => {
      const next = { ...state, lastEventSeq: event.seq, lastEventAt: event.at };
      if (event.type === "command_ack" && event.commandSeq)
        next.lastCommandSeq = Math.max(next.lastCommandSeq, event.commandSeq);
      else if (event.type === "rpc_started") {
        next.status = "waiting";
        delete next.error;
      } else if (event.type === "liveness_recovered") {
        next.status = "waiting";
        delete next.error;
      } else if (event.type === "agent_start") {
        next.status = "running";
        next.turn += 1;
      } else if (event.type === "agent_settled") next.status = "waiting";
      else if (event.type === "stopped") next.status = "stopped";
      else if (event.type === "killed") next.status = "killed";
      else if (event.type === "orphaned") next.status = "orphaned";
      else if (event.type === "failed" || event.type === "rpc_exit") {
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
