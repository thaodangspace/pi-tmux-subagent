import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentTool } from "../../src/extension/tool.js";
import { Manager } from "../../src/manager/manager.js";
import { ProtocolStore } from "../../src/protocol/store.js";
import { workerId } from "../../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  );
});

async function setupTool() {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-"));
  roots.push(root);
  const store = new ProtocolStore(root);
  const manager = new Manager({ store });
  let registeredTool: any;
  const pi = {
    registerTool: vi.fn((tool) => {
      registeredTool = tool;
    }),
  };
  registerSubagentTool(pi as any, manager);
  return { root, store, manager, tool: registeredTool };
}

describe("subagent tool registration and execution", () => {
  it("registers tool with clear opt-in descriptions for result and events", async () => {
    const { tool } = await setupTool();
    expect(tool.name).toBe("subagent");
    expect(tool.description).toContain("result");
    expect(tool.description).toContain("opt-in");
    expect(tool.description).toContain("events");
    expect(tool.promptSnippet).toContain("full results/events");
    expect(tool.parameters.properties.action.enum).toContain("result");
    expect(tool.parameters.properties.action.enum).toContain("events");
    expect(tool.parameters.properties.mode).toBeDefined();
    expect(tool.parameters.properties.turn).toBeDefined();
    expect(tool.parameters.properties.resultSeq).toBeDefined();
    expect(tool.parameters.properties.fromSeq).toBeDefined();
    expect(tool.parameters.properties.limit).toBeDefined();
  });

  it("fetches full result on action: 'result'", async () => {
    const { tool, store } = await setupTool();
    const id = workerId("worker1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-worker1",
        createdAt: new Date().toISOString(),
        cwd: "/tmp",
        launch: { task: "inspect" },
      },
      {
        version: 1,
        id,
        status: "completed",
        turn: 1,
        lastCommandSeq: 1,
        lastEventSeq: 5,
      },
    );
    await store.writeResult({
      version: 1,
      id,
      turn: 1,
      commandSeq: 1,
      resultSeq: 5,
      eventSeq: 5,
      text: "Full detailed output of inspection",
      completedAt: new Date().toISOString(),
      workspace: { mode: "current", root: "/tmp" },
    });

    const res = await tool.execute(
      "call1",
      { action: "result", id: "worker1", turn: 1, resultSeq: 5 },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toMatchObject({
      version: 1,
      id: "worker1",
      turn: 1,
      commandSeq: 1,
      resultSeq: 5,
      text: "Full detailed output of inspection",
    });
    expect(res.details).toEqual(parsed);

    await expect(
      tool.execute(
        "call-mismatch",
        { action: "result", id: "worker1", turn: 1, resultSeq: 6 },
        undefined,
        undefined,
        { cwd: "/tmp" },
      ),
    ).rejects.toMatchObject({ code: "RESULT_CORRELATION_NOT_FOUND" });
  });

  it("fetches bounded event history on action: 'events'", async () => {
    const { tool, store } = await setupTool();
    const id = workerId("worker1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-worker1",
        createdAt: new Date().toISOString(),
        cwd: "/tmp",
        launch: { task: "inspect" },
      },
      {
        version: 1,
        id,
        status: "completed",
        turn: 1,
        lastCommandSeq: 1,
        lastEventSeq: 3,
      },
    );
    for (let i = 1; i <= 5; i++) {
      await store.appendEvent(id, { type: "step", data: i });
    }

    const res = await tool.execute(
      "call2",
      {
        action: "events",
        id: "worker1",
        fromSeq: 2,
        limit: 2,
      },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toMatchObject({
      version: 1,
      id: "worker1",
      fromSeq: 2,
      nextSeq: 4,
      hasMore: true,
    });
    expect(parsed.events.map((e: any) => e.seq)).toEqual([2, 3]);
  });

  it("throws clear error when worker is not found", async () => {
    const { tool } = await setupTool();
    await expect(
      tool.execute(
        "call3",
        { action: "result", id: "nonexistent" },
        undefined,
        undefined,
        { cwd: "/tmp" },
      ),
    ).rejects.toMatchObject({
      code: "WORKER_NOT_FOUND",
      message: expect.stringContaining("Worker not found: nonexistent"),
    });

    await expect(
      tool.execute(
        "call4",
        { action: "events", id: "nonexistent" },
        undefined,
        undefined,
        { cwd: "/tmp" },
      ),
    ).rejects.toMatchObject({
      code: "WORKER_NOT_FOUND",
      message: expect.stringContaining("Worker not found: nonexistent"),
    });
  });

  it("throws clear error when result is not available", async () => {
    const { tool, store } = await setupTool();
    const id = workerId("running1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-running1",
        createdAt: new Date().toISOString(),
        cwd: "/tmp",
        launch: { task: "inspect" },
      },
      {
        version: 1,
        id,
        status: "running",
        turn: 1,
        lastCommandSeq: 1,
        lastEventSeq: 1,
      },
    );

    await expect(
      tool.execute(
        "call5",
        { action: "result", id: "running1" },
        undefined,
        undefined,
        { cwd: "/tmp" },
      ),
    ).rejects.toMatchObject({
      code: "RESULT_NOT_FOUND",
      message: expect.stringContaining(
        "No result available for worker: running1",
      ),
    });
  });

  it("emits transient tool progress updates identifying selected agent", async () => {
    const { root, manager, tool } = await setupTool();
    await mkdir(join(root, ".pi/agents"), { recursive: true });
    await writeFile(
      join(root, ".pi/agents/reviewer.md"),
      "---\nname: reviewer\n---\nReview code.",
    );

    manager.spawn = vi.fn(async (config: any) => ({
      version: 1 as const,
      id: workerId("worker-spawned"),
      status: "starting" as const,
      turn: 0,
      lastCommandSeq: 0,
      lastEventSeq: 0,
    }));

    const ctx = {
      cwd: root,
      sessionManager: { getSessionId: () => "session-1" },
    };

    // Case 1: spawn with agent only
    const onUpdate1 = vi.fn();
    await tool.execute(
      "c1",
      { action: "spawn", agent: "reviewer", task: "review PR" },
      undefined,
      onUpdate1,
      ctx,
    );
    expect(onUpdate1).toHaveBeenCalledWith({
      content: [{ type: "text", text: "spawn reviewer…" }],
      details: {},
    });
    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "reviewer",
        name: "reviewer",
        task: "review PR",
      }),
      root,
      undefined,
      "session-1",
    );

    // Case 2: spawn with agent and distinct custom name
    const onUpdate2 = vi.fn();
    await tool.execute(
      "c2",
      {
        action: "spawn",
        agent: "reviewer",
        name: "auth-review",
        task: "review auth",
      },
      undefined,
      onUpdate2,
      ctx,
    );
    expect(onUpdate2).toHaveBeenCalledWith({
      content: [{ type: "text", text: "spawn auth-review [reviewer]…" }],
      details: {},
    });
    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "reviewer",
        name: "auth-review",
        task: "review auth",
      }),
      root,
      undefined,
      "session-1",
    );

    // Case 3: spawn with agent and same name
    const onUpdate3 = vi.fn();
    await tool.execute(
      "c3",
      {
        action: "spawn",
        agent: "reviewer",
        name: "reviewer",
        task: "review auth",
      },
      undefined,
      onUpdate3,
      ctx,
    );
    expect(onUpdate3).toHaveBeenCalledWith({
      content: [{ type: "text", text: "spawn reviewer…" }],
      details: {},
    });

    // Case 4: spawn with custom name only (unnamed agent)
    const onUpdate4 = vi.fn();
    await tool.execute(
      "c4",
      { action: "spawn", name: "custom-job", task: "custom task" },
      undefined,
      onUpdate4,
      ctx,
    );
    expect(onUpdate4).toHaveBeenCalledWith({
      content: [{ type: "text", text: "spawn custom-job…" }],
      details: {},
    });

    // Case 5: spawn without name or agent
    const onUpdate5 = vi.fn();
    await tool.execute(
      "c5",
      { action: "spawn", task: "plain task" },
      undefined,
      onUpdate5,
      ctx,
    );
    expect(onUpdate5).toHaveBeenCalledWith({
      content: [{ type: "text", text: "spawn…" }],
      details: {},
    });

    // Case 6: non-spawn action keeps standard update
    manager.stop = vi.fn(async () => 1);
    const onUpdate6 = vi.fn();
    await tool.execute(
      "c6",
      { action: "stop", id: "worker-1" },
      undefined,
      onUpdate6,
      ctx,
    );
    expect(onUpdate6).toHaveBeenCalledWith({
      content: [{ type: "text", text: "stop…" }],
      details: {},
    });
  });
});
