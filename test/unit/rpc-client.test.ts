import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/runner/rpc-client.js";

describe("JSONL codec", () => {
  it("handles split UTF-8 and coalesced LF records", () => {
    const decoder = new JsonlDecoder();
    const input = Buffer.from('{"x":"💡"}\n{"y":2}\r\n');
    expect(decoder.push(input.subarray(0, 9))).toEqual([]);
    expect(decoder.push(input.subarray(9))).toEqual([{ x: "💡" }, { y: 2 }]);
    expect(decoder.end()).toEqual([]);
  });
  it("does not split Unicode line separators", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"x":"a b"}\n')).toEqual([{ x: "a b" }]);
  });
});
