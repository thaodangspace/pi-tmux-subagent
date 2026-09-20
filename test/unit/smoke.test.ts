import { describe, expect, it } from "vitest";
import { HELP } from "../../src/cli.js";
import { workerId } from "../../src/types.js";

describe("package scaffold", () => {
  it("exposes CLI help and validates identifiers", () => {
    expect(HELP).toContain("spawn <task>");
    expect(workerId("worker-123")).toBe("worker-123");
    expect(() => workerId("NO")).toThrow(/Invalid worker id/);
  });
});
