import { describe, expect, it } from "vitest";
import { reduceEvents } from "../../src/protocol/state.js";
import { workerId } from "../../src/types.js";

describe("state reducer", () => {
  it("transitions settled worker to waiting instead of terminal completed", () => {
    const id = workerId("abc123");
    const state = reduceEvents(
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
      [
        { version: 1, seq: 1, at: "a", type: "rpc_started" },
        { version: 1, seq: 2, at: "b", type: "command_ack", commandSeq: 1 },
        { version: 1, seq: 3, at: "c", type: "agent_start" },
        { version: 1, seq: 4, at: "d", type: "agent_settled" },
      ],
    );
    expect(state).toMatchObject({
      status: "waiting",
      turn: 1,
      lastCommandSeq: 1,
      lastEventSeq: 4,
    });
  });

  it("does not revive orphaned worker on ordinary rpc_started event", () => {
    const id = workerId("abc123");
    const state = reduceEvents(
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
      [
        { version: 1, seq: 1, at: "a", type: "orphaned" },
        { version: 1, seq: 2, at: "b", type: "rpc_started" },
      ],
    );
    expect(state).toMatchObject({ status: "orphaned", lastEventSeq: 2 });
  });

  it("revives orphaned worker back to waiting when explicit liveness_recovered arrives", () => {
    const id = workerId("abc123");
    const state = reduceEvents(
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
      [
        { version: 1, seq: 1, at: "a", type: "orphaned" },
        { version: 1, seq: 2, at: "b", type: "liveness_recovered" },
      ],
    );
    expect(state).toMatchObject({ status: "waiting", lastEventSeq: 2 });
  });
});
