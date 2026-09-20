import type { WorkerCompletion, WorkerResult } from "./types.js";

/** Maximum UTF-8 size of a completion summary written to completion.json. */
export const MAX_COMPLETION_SUMMARY_BYTES = 512;

function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const suffix = "…";
  const budget = maximum - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return output.trimEnd() + suffix;
}

/**
 * Produces the text safe for automatic delivery. Producers may supply an
 * explicit final-output summary; otherwise the complete assistant text is
 * whitespace-normalized and deterministically truncated.
 */
export function completionSummary(assistantText: string, explicitSummary?: string): string {
  const candidate = (explicitSummary?.trim() || assistantText.trim() || "Completed without a text response.")
    .replace(/\s+/g, " ");
  return truncateUtf8(candidate, MAX_COMPLETION_SUMMARY_BYTES);
}

export function completedNotification(result: WorkerResult, explicitSummary?: string): WorkerCompletion {
  const summary = completionSummary(result.text, explicitSummary);
  return {
    version: 1,
    id: result.id,
    turn: result.turn,
    ...(result.commandSeq !== undefined ? { commandSeq: result.commandSeq } : {}),
    resultSeq: result.resultSeq ?? result.eventSeq,
    status: "completed",
    summary,
    hasDetails: summary !== result.text || result.workspace !== undefined,
    completedAt: result.completedAt,
  };
}
