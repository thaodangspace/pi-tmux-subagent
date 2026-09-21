import { formatToolDetail } from "./format.js";

export type PresentationEvent =
  | { kind: "agent_start" }
  | { kind: "agent_settled" }
  | { kind: "tool_start"; toolName: string; detail?: string }
  | { kind: "tool_end"; toolName: string }
  | { kind: "text_delta"; delta: string }
  | { kind: "message_end"; role?: string; text?: string }
  | { kind: "error"; message: string }
  | { kind: "unresponsive"; message?: string }
  | { kind: "responsive"; message?: string };

/**
 * Normalizes raw Pi RPC events or runner events into structured presentation events.
 * Returns undefined for internal/noise events that should not affect presentation.
 */
export function normalizeRpcEvent(event: any): PresentationEvent | undefined {
  if (!event || typeof event !== "object") return undefined;

  if (
    event.type === "message_update" &&
    event.assistantMessageEvent?.type === "text_delta"
  ) {
    const delta = event.assistantMessageEvent.delta;
    return typeof delta === "string"
      ? { kind: "text_delta", delta }
      : undefined;
  }

  if (event.type === "tool_execution_start") {
    const toolName = String(event.toolName ?? "tool");
    const detail = formatToolDetail(toolName, event.args);
    return {
      kind: "tool_start",
      toolName,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      kind: "tool_end",
      toolName: String(event.toolName ?? "tool"),
    };
  }

  if (event.type === "agent_start") {
    return { kind: "agent_start" };
  }

  if (event.type === "agent_settled") {
    return { kind: "agent_settled" };
  }

  if (event.type === "message_end") {
    const role = event.message?.role;
    let text: string | undefined;
    if (role === "assistant") {
      if (Array.isArray(event.message?.content)) {
        text = event.message.content
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n");
      } else if (typeof event.message?.content === "string") {
        text = event.message.content;
      }
    }
    return {
      kind: "message_end",
      ...(role ? { role: String(role) } : {}),
      ...(text !== undefined ? { text } : {}),
    };
  }

  if (event.type === "extension_error") {
    return {
      kind: "error",
      message: String(event.error ?? "extension error"),
    };
  }

  if (event.type === "unresponsive") {
    return {
      kind: "unresponsive",
      ...(event.data ? { message: String(event.data) } : {}),
    };
  }

  if (event.type === "responsive") {
    return {
      kind: "responsive",
      ...(event.data ? { message: String(event.data) } : {}),
    };
  }

  if (event.type === "failed") {
    return {
      kind: "error",
      message: String(event.data ?? event.error ?? "worker failed"),
    };
  }

  return undefined;
}

/**
 * Format a presentation event as a simple text snippet (legacy/fallback mode).
 */
export function formatPresentationEvent(
  event: PresentationEvent,
): string | undefined {
  switch (event.kind) {
    case "text_delta":
      return event.delta;
    case "tool_start":
      return `\n[tool] ${event.toolName}${event.detail ? ` ${event.detail}` : ""}\n`;
    case "agent_start":
      return "\n[agent running]\n";
    case "agent_settled":
      return "\n[agent waiting]\n";
    case "error":
      return `\n[error] ${event.message}\n`;
    case "unresponsive":
      return `\n[unresponsive] ${event.message ?? "worker unresponsive"}\n`;
    case "responsive":
      return "\n[responsive]\n";
    case "tool_end":
    case "message_end":
      return undefined;
  }
}

/**
 * Legacy RPC event renderer for plain streaming output.
 */
export function renderRpcEvent(event: any): string | undefined {
  const presentation = normalizeRpcEvent(event);
  return presentation ? formatPresentationEvent(presentation) : undefined;
}
