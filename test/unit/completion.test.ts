import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { completedNotification, completionSummary, MAX_COMPLETION_SUMMARY_BYTES } from "../../src/protocol/completion.js";
import { workerId } from "../../src/types.js";

const id = workerId("complete1");

describe("worker completion protocol", () => {
  it("uses an explicit summary and deterministically bounds UTF-8 output", () => {
    expect(completionSummary("ignored", "  concise\n result  ")).toBe("concise result");
    const value = completionSummary("🙂 ".repeat(1_000));
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(MAX_COMPLETION_SUMMARY_BYTES);
    expect(value.endsWith("…")).toBe(true);
    expect(completionSummary("🙂 ".repeat(1_000))).toBe(value);
  });

  it("links a completed notification to the full result without duplicating it", () => {
    const text = "details ".repeat(200);
    const completion = completedNotification({
      version: 1, id, turn: 2, commandSeq: 4, text,
      completedAt: "2026-01-01T00:00:00Z", resultSeq: 17, eventSeq: 17,
    });
    expect(completion).toMatchObject({ id, turn: 2, commandSeq: 4, resultSeq: 17, status: "completed", hasDetails: true });
    expect(completion.summary).not.toBe(text);
    expect(JSON.stringify(completion)).not.toContain(text);
  });
});
