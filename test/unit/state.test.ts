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

  it.each(["stopped", "failed", "killed"] as const)(
    "keeps %s sticky under late settled, responsive, and start events",
    (terminal) => {
      const id = workerId("abc123");
      const state = reduceEvents(
        {
          version: 1,
          id,
          status: terminal,
          turn: 1,
          lastCommandSeq: 1,
          lastEventSeq: 4,
        },
        [
          { version: 1, seq: 5, at: "e", type: "agent_settled" },
          { version: 1, seq: 6, at: "f", type: "responsive" },
          { version: 1, seq: 7, at: "g", type: "agent_start" },
        ],
      );
      expect(state).toMatchObject({
        status: terminal,
        turn: 1,
        lastEventSeq: 7,
      });
    },
  );

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
