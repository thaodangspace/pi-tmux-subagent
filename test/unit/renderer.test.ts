import { describe, expect, it } from "vitest";
import {
  formatPresentationEvent,
  normalizeRpcEvent,
  renderRpcEvent,
} from "../../src/runner/renderer.js";

describe("renderer: event normalization", () => {
  it("normalizes agent lifecycle events", () => {
    expect(normalizeRpcEvent({ type: "agent_start" })).toEqual({
      kind: "agent_start",
    });
    expect(normalizeRpcEvent({ type: "agent_settled" })).toEqual({
      kind: "agent_settled",
    });
  });

  it("normalizes tool execution start with various argument shapes", () => {
    // 1. Grep pattern
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "grep",
        args: { pattern: "refreshToken" },
      }),
    ).toEqual({
      kind: "tool_start",
      toolName: "grep",
      detail: "refreshToken",
    });

    // 2. File path (read_file)
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: "src/auth/token.ts" },
      }),
    ).toEqual({
      kind: "tool_start",
      toolName: "read",
      detail: "src/auth/token.ts",
    });

    // 3. Bash command
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "npm test -- --watch" },
      }),
    ).toEqual({
      kind: "tool_start",
      toolName: "bash",
      detail: "npm test -- --watch",
    });

    // 4. String argument
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "eval",
        args: "console.log('hello')",
      }),
    ).toEqual({
      kind: "tool_start",
      toolName: "eval",
      detail: "console.log('hello')",
    });

    // 5. No arguments
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "list_files",
      }),
    ).toEqual({
      kind: "tool_start",
      toolName: "list_files",
    });

    // 6. Generic object argument
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "custom",
        args: { key: "value" },
      }),
    ).toEqual({
      kind: "tool_start",
      toolName: "custom",
      detail: "key: value",
    });
  });

  it("normalizes tool execution end", () => {
    expect(
      normalizeRpcEvent({
        type: "tool_execution_end",
        toolName: "grep",
      }),
    ).toEqual({
      kind: "tool_end",
      toolName: "grep",
    });
  });

  it("normalizes text delta updates", () => {
    expect(
      normalizeRpcEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Analyzing code...",
        },
      }),
    ).toEqual({
      kind: "text_delta",
      delta: "Analyzing code...",
    });

    // Non-text delta message update should be ignored
    expect(
      normalizeRpcEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
      }),
    ).toBeUndefined();
  });

  it("normalizes message end events", () => {
    expect(
      normalizeRpcEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Finished token inspection." }],
        },
      }),
    ).toEqual({
      kind: "message_end",
      role: "assistant",
      text: "Finished token inspection.",
    });

    expect(
      normalizeRpcEvent({
        type: "message_end",
        message: {
          role: "user",
        },
      }),
    ).toEqual({
      kind: "message_end",
      role: "user",
    });
  });

  it("normalizes errors and unresponsiveness", () => {
    expect(
      normalizeRpcEvent({
        type: "extension_error",
        error: "Subprocess crashed with code 1",
      }),
    ).toEqual({
      kind: "error",
      message: "Subprocess crashed with code 1",
    });

    expect(
      normalizeRpcEvent({
        type: "unresponsive",
        data: "No response after 10000ms",
      }),
    ).toEqual({
      kind: "unresponsive",
      message: "No response after 10000ms",
    });

    expect(
      normalizeRpcEvent({
        type: "responsive",
      }),
    ).toEqual({
      kind: "responsive",
    });
  });

  it("ignores unknown or malformed events", () => {
    expect(normalizeRpcEvent(null)).toBeUndefined();
    expect(normalizeRpcEvent(undefined)).toBeUndefined();
    expect(normalizeRpcEvent({})).toBeUndefined();
    expect(normalizeRpcEvent({ type: "internal_ping" })).toBeUndefined();
  });

  describe("formatPresentationEvent & renderRpcEvent", () => {
    it("formats tool start cleanly", () => {
      const pres = normalizeRpcEvent({
        type: "tool_execution_start",
        toolName: "grep",
        args: { pattern: "refreshToken" },
      })!;
      expect(formatPresentationEvent(pres)).toBe(
        "\n[tool] grep refreshToken\n",
      );
    });

    it("formats text delta directly", () => {
      const pres = normalizeRpcEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "chunk" },
      })!;
      expect(formatPresentationEvent(pres)).toBe("chunk");
    });

    it("legacy renderRpcEvent compatibility", () => {
      expect(
        renderRpcEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "delta" },
        }),
      ).toBe("delta");
      expect(renderRpcEvent({ type: "agent_start" })).toBe(
        "\n[agent running]\n",
      );
      expect(renderRpcEvent({ type: "agent_settled" })).toBe(
        "\n[agent waiting]\n",
      );
    });
  });
});
