import type {
  WorkerCommand,
  WorkerEvent,
  WorkerMeta,
  WorkerResult,
  WorkerState,
  WorkerStatus,
} from "../protocol/types.js";

export type ActivityKind = "tool" | "assistant" | "command" | "state" | "error";
export interface ActivityView {
  at: string;
  text: string;
  kind: ActivityKind;
}
export interface WorkerActivityView {
  id: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  modelLabel?: string;
  status: WorkerStatus;
  turn: number;
  startedAt?: string;
  updatedAt?: string;
  elapsedMs?: number;
  latestActivity?: string;
  latestActivityKind?: ActivityKind;
}
export interface WorkerProjectionInput {
  state: WorkerState;
  meta?: WorkerMeta;
  events?: WorkerEvent[];
  commands?: WorkerCommand[];
  result?: WorkerResult;
}

const DEFAULT_ACTIVITY_LIMIT = 120;
function bounded(value: unknown, limit = DEFAULT_ACTIVITY_LIMIT): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1))}…`;
}
function eventData(event: WorkerEvent): any {
  return event.data && typeof event.data === "object" ? event.data : {};
}

export function eventActivity(
  event: WorkerEvent,
  limit = DEFAULT_ACTIVITY_LIMIT,
): ActivityView | undefined {
  const data = eventData(event);
  if (event.type === "message_update" || event.type === "tool_execution_update")
    return undefined;
  if (event.type === "tool_execution_start") {
    const args =
      data.args === undefined
        ? ""
        : ` ${bounded(typeof data.args === "string" ? data.args : JSON.stringify(data.args), limit)}`;
    return {
      at: event.at,
      kind: "tool",
      text: bounded(`[tool] ${data.toolName ?? "tool"}${args}`, limit),
    };
  }
  if (event.type === "message_end" && data.message?.role === "assistant") {
    const text = Array.isArray(data.message.content)
      ? data.message.content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => part.text)
          .join(" ")
      : "";
    return text
      ? { at: event.at, kind: "assistant", text: bounded(text, limit) }
      : undefined;
  }
  if (event.type === "failed" || event.type === "extension_error")
    return {
      at: event.at,
      kind: "error",
      text: bounded(
        `error: ${data.error ?? event.data ?? "worker failed"}`,
        limit,
      ),
    };
  if (event.type === "liveness_suspected")
    return { at: event.at, kind: "error", text: "worker liveness degraded" };
  if (event.type === "liveness_recovered")
    return { at: event.at, kind: "state", text: "worker liveness recovered" };
  if (event.type === "orphaned")
    return { at: event.at, kind: "error", text: "worker orphaned" };
  if (event.type === "agent_start")
    return { at: event.at, kind: "state", text: "agent running" };
  if (event.type === "agent_settled")
    return { at: event.at, kind: "state", text: "ready for next instruction" };
  if (event.type === "completed")
    return { at: event.at, kind: "state", text: "completed" };
  if (event.type === "stopped")
    return { at: event.at, kind: "state", text: "stopped" };
  if (event.type === "killed")
    return { at: event.at, kind: "error", text: "force-terminated" };
  return undefined;
}

function commandActivity(command: WorkerCommand, limit: number): ActivityView {
  switch (command.type) {
    case "stop":
    case "abort":
      return { at: command.at, kind: "command", text: command.type };
    case "prompt":
    case "send":
    case "steer":
      return {
        at: command.at,
        kind: "command",
        text: bounded(`${command.type}: ${command.text}`, limit),
      };
  }
}

export function recentActivity(
  input: WorkerProjectionInput,
  count = 8,
  limit = DEFAULT_ACTIVITY_LIMIT,
): ActivityView[] {
  const activities = [
    ...(input.events ?? [])
      .map((event) => eventActivity(event, limit))
      .filter((value): value is ActivityView => Boolean(value)),
    ...(input.commands ?? []).map((command) => commandActivity(command, limit)),
  ];
  return activities
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-Math.max(0, count));
}

export function modelSelectionLabel(selection?: {
  provider?: string;
  model?: string;
  thinking?: string;
}): string | undefined {
  if (!selection) return undefined;
  const model =
    selection.provider && selection.model
      ? `${selection.provider}/${selection.model}`
      : (selection.model ?? selection.provider);
  return model
    ? `${model}${selection.thinking ? `-${selection.thinking}` : ""}`
    : selection.thinking
      ? `thinking:${selection.thinking}`
      : undefined;
}

export function projectWorker(
  input: WorkerProjectionInput,
  now = Date.now(),
  limit = DEFAULT_ACTIVITY_LIMIT,
): WorkerActivityView {
  const { state, meta } = input;
  const selection = meta?.activeModel ?? meta?.launch;
  const modelLabel = modelSelectionLabel(selection);
  const latest = recentActivity(input, 1, limit)[0];
  const startedAt = meta?.createdAt;
  const updatedAt = latest?.at ?? state.lastEventAt ?? startedAt;
  return {
    id: state.id,
    ...(meta?.launch.name ? { name: meta.launch.name } : {}),
    ...(selection?.provider ? { provider: selection.provider } : {}),
    ...(selection?.model ? { model: selection.model } : {}),
    ...(selection?.thinking ? { thinking: selection.thinking } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    status: state.status,
    turn: state.turn,
    ...(startedAt
      ? { startedAt, elapsedMs: Math.max(0, now - Date.parse(startedAt)) }
      : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(latest
      ? { latestActivity: latest.text, latestActivityKind: latest.kind }
      : {
          latestActivity: statusActivity(state),
          latestActivityKind:
            state.status === "failed" ||
            state.status === "killed" ||
            state.status === "orphaned"
              ? "error"
              : "state",
        }),
  };
}

function statusActivity(state: WorkerState): string {
  if (state.error) return bounded(state.error);
  switch (state.status) {
    case "starting":
      return "starting";
    case "running":
      return "agent running";
    case "waiting":
      return "ready for next instruction";
    case "completed":
      return "completed";
    case "failed":
      return "worker failed";
    case "stopped":
      return "stopped";
    case "killed":
      return "force-terminated";
    case "orphaned":
      return "worker orphaned";
  }
}
