import type { WorkerStatus } from "../protocol/types.js";

/**
 * Truncate a single line of text to fit within a given column width.
 * Appends ellipsis if truncated.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/**
 * Pad or truncate text to exactly fit a target width.
 */
export function pad(text: string, width: number): string {
  const value = truncate(text, width);
  return value + " ".repeat(Math.max(0, width - value.length));
}

/**
 * Format elapsed milliseconds as MM:SS or H:MM:SS.
 */
export function elapsed(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "--:--";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Standardize worker identity presentation across monitors, widgets, and inspect.
 */
export function formatWorkerIdentity(worker: {
  name?: string | undefined;
  agent?: string | undefined;
  id?: string | undefined;
}): string {
  if (worker.name && worker.agent) {
    return worker.name !== worker.agent
      ? `${worker.name} [${worker.agent}]`
      : worker.name;
  }
  return worker.name ?? worker.agent ?? worker.id ?? "";
}

/**
 * Standardize model and thinking configuration label.
 */
export function modelSelectionLabel(selection?: {
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
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

export interface FormattedStatus {
  dot: string;
  label: string;
  text: string;
}

/**
 * Maps worker status to icon dot, label, and composite text.
 */
export function formatStatus(status: WorkerStatus | string): FormattedStatus {
  switch (status) {
    case "running":
      return { dot: "●", label: "running", text: "● running" };
    case "waiting":
      return { dot: "○", label: "waiting", text: "○ waiting" };
    case "starting":
      return { dot: "…", label: "starting", text: "… starting" };
    case "completed":
      return { dot: "✔", label: "completed", text: "✔ completed" };
    case "failed":
      return { dot: "✖", label: "failed", text: "✖ failed" };
    case "stopped":
      return { dot: "■", label: "stopped", text: "■ stopped" };
    case "orphaned":
      return { dot: "✖", label: "orphaned", text: "✖ orphaned" };
    case "unresponsive":
      return { dot: "⚠", label: "unresponsive", text: "⚠ unresponsive" };
    default:
      return { dot: "·", label: status, text: `· ${status}` };
  }
}

/**
 * Intelligently extract meaningful, human-readable argument target from tool arguments.
 * Avoids dumping massive payloads while extracting key targets (path, pattern, command, etc.).
 */
export function formatToolDetail(
  _toolName: string,
  args: unknown,
  limit = 60,
): string | undefined {
  if (args === null || args === undefined) return undefined;
  if (typeof args === "string") {
    const cleaned = args.replace(/\s+/g, " ").trim();
    return cleaned ? truncate(cleaned, limit) : undefined;
  }
  if (typeof args !== "object") {
    return truncate(String(args), limit);
  }

  const record = args as Record<string, unknown>;

  // High-priority keys often holding the primary subject of tool execution
  const candidateKeys = [
    "command",
    "CommandLine",
    "cmd",
    "pattern",
    "query",
    "Query",
    "path",
    "filePath",
    "TargetFile",
    "AbsolutePath",
    "file",
    "prompt",
    "Prompt",
    "text",
    "url",
    "Url",
  ];

  for (const key of candidateKeys) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) {
      return truncate(val.replace(/\s+/g, " ").trim(), limit);
    }
  }

  // Look for any first non-empty string property
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === "string" && val.trim()) {
      return truncate(`${key}: ${val.replace(/\s+/g, " ").trim()}`, limit);
    }
  }

  // Otherwise compact JSON
  try {
    const json = JSON.stringify(record);
    if (json === "{}") return undefined;
    return truncate(json, limit);
  } catch {
    return undefined;
  }
}

/**
 * Wrap a paragraph or multiline text so each line fits within maxWidth.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const rawLines = text.split("\n");
  const result: string[] = [];

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trimEnd();
    if (trimmed.length <= maxWidth) {
      result.push(trimmed);
      continue;
    }

    // Word wrap
    const words = trimmed.split(" ");
    let current = "";
    for (const word of words) {
      if (!word) continue;
      if (!current) {
        if (word.length <= maxWidth) {
          current = word;
        } else {
          // Word itself exceeds maxWidth
          result.push(truncate(word, maxWidth));
        }
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += ` ${word}`;
      } else {
        result.push(current);
        if (word.length <= maxWidth) {
          current = word;
        } else {
          result.push(truncate(word, maxWidth));
          current = "";
        }
      }
    }
    if (current) {
      result.push(current);
    }
  }

  return result;
}
