import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolStore } from "../../src/protocol/store.js";
import { Manager } from "../../src/manager/manager.js";
import { CompletionNotifier } from "../../src/extension/completion-notifier.js";
import { TmuxAdapter } from "../../src/tmux/adapter.js";
import { workerId } from "../../src/types.js";

const cleanup: { root: string; child?: ChildProcess; tmuxId?: string }[] = [];
const tmuxAdapter = new TmuxAdapter();

afterEach(async () => {
  for (const x of cleanup.splice(0)) {
    x.child?.kill();
    if (x.tmuxId) {
      await tmuxAdapter.terminate(x.tmuxId).catch(() => undefined);
    }
    await rm(x.root, { recursive: true, force: true });
  }
});

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeout = 10000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for condition");
}

describe("durable lifecycle", () => {
  it("runner outlives managers, accepts follow-ups, filters streaming events, and turns are scoped", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-int-"));
    const store = new ProtocolStore(root);
    const id = workerId("integration1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-integration1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "first" },
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendCommand(id, { type: "prompt", text: "first" });

    const child = spawn(
      process.execPath,
      [resolve("dist/runner/main.js"), store.dir(id)],
      {
        env: {
          ...process.env,
          PI_TMUX_RPC_COMMAND: process.execPath,
          PI_TMUX_RPC_ARGS: JSON.stringify([
            resolve("test/fixtures/fake-rpc-child.mjs"),
          ]),
        },
        stdio: "ignore",
      },
    );
    cleanup.push({ root, child });

    // Wait for first command to be processed and result written
    const res1 = await waitFor(async () => {
      const res = await store.readResult(id);
      return res?.turn === 1 ? res : undefined;
    });
    expect(res1.turn).toBe(1);
    expect(res1.commandSeq).toBe(1);
    expect(res1.text).toBe("reply-1:first");

    // Parent restart: a brand new ProtocolStore instance connects to the running worker
    const restartedStore = new ProtocolStore(root);
    await restartedStore.appendCommand(id, { type: "send", text: "second" });

    await waitFor(async () =>
      (await restartedStore.readState(id)).lastCommandSeq === 2
        ? true
        : undefined,
    );
    const res2 = await waitFor(async () => {
      const value = await restartedStore.readResult(id);
      return value?.turn === 2 ? value : undefined;
    });
    expect(res2.text).toBe("reply-2:second");
    expect(res2.turn).toBe(2);
    expect(res2.commandSeq).toBe(2);

    // Verify commands were acked in order
    const acks = (await restartedStore.readLog<any>(id, "events")).filter(
      (x) => x.type === "command_ack",
    );
    expect(acks.map((x) => x.commandSeq)).toEqual([1, 2]);

    // Verify high-frequency message_update streaming events are NOT in events.jsonl
    const allEvents = await restartedStore.readLog<any>(id, "events");
    const streamingEvents = allEvents.filter(
      (x) => x.type === "message_update",
    );
    expect(streamingEvents).toHaveLength(0);

    // Clean stop
    await restartedStore.appendCommand(id, { type: "stop" });
    await waitFor(async () =>
      (await restartedStore.readState(id)).status === "stopped"
        ? true
        : undefined,
    );
  });

  it("handles RPC extension UI dialog requests without hanging", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-dialog-"));
    const store = new ProtocolStore(root);
    const id = workerId("dialog1");
    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-dialog1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "first" },
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendCommand(id, { type: "prompt", text: "trigger_dialog" });

    const child = spawn(
      process.execPath,
      [resolve("dist/runner/main.js"), store.dir(id)],
      {
        env: {
          ...process.env,
          PI_TMUX_RPC_COMMAND: process.execPath,
          PI_TMUX_RPC_ARGS: JSON.stringify([
            resolve("test/fixtures/fake-rpc-child.mjs"),
          ]),
        },
        stdio: "ignore",
      },
    );
    cleanup.push({ root, child });

    // The fake child emits an extension_ui_request and waits for extension_ui_response.
    // The runner should automatically reply with cancelled: true and unblock the turn.
    const result = await waitFor(async () => {
      const r = await store.readResult(id);
      return r?.text?.includes("reply-1:trigger_dialog") ? r : undefined;
    }, 6000);
    expect(result.text).toBe("reply-1:trigger_dialog");

    await store.appendCommand(id, { type: "stop" });
  });

  it("resumes Pi session across runner crash and restart so conversation context survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-resume-"));
    const store = new ProtocolStore(root);
    const id = workerId("resume1");
    const fakeSessionFile = join(root, "session.json");
    await writeFile(fakeSessionFile, JSON.stringify({ count: 0, memory: {} }));

    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-resume1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "remember: secret-token-xyz" },
        piSessionFile: fakeSessionFile,
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendCommand(id, {
      type: "prompt",
      text: "remember: secret-token-xyz",
    });

    // Start runner 1
    const runner1 = spawn(
      process.execPath,
      [resolve("dist/runner/main.js"), store.dir(id)],
      {
        env: {
          ...process.env,
          PI_TMUX_RPC_COMMAND: process.execPath,
          PI_TMUX_RPC_ARGS: JSON.stringify([
            resolve("test/fixtures/fake-rpc-child.mjs"),
          ]),
        },
        stdio: "ignore",
      },
    );
    cleanup.push({ root, child: runner1 });

    // Wait for turn 1 to complete
    const res1 = await waitFor(async () => {
      const res = await store.readResult(id);
      return res?.turn === 1 ? res : undefined;
    });
    expect(res1.turn).toBe(1);

    // CRASH runner 1 hard with SIGKILL
    runner1.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));

    // RESTART runner: launch a new runner on the same worker directory
    const runner2 = spawn(
      process.execPath,
      [resolve("dist/runner/main.js"), store.dir(id)],
      {
        env: {
          ...process.env,
          PI_TMUX_RPC_COMMAND: process.execPath,
          PI_TMUX_RPC_ARGS: JSON.stringify([
            resolve("test/fixtures/fake-rpc-child.mjs"),
          ]),
        },
        stdio: "ignore",
      },
    );
    cleanup.push({ root, child: runner2 });

    // Send follow-up command asking to recall the secret
    await store.appendCommand(id, { type: "send", text: "recall" });

    // Wait for turn 2 to be processed and completed by restarted runner
    await waitFor(async () =>
      (await store.readState(id)).lastCommandSeq === 2 ? true : undefined,
    );
    const res2 = await waitFor(async () => {
      const r = await store.readResult(id);
      return r?.turn === 2 ? r : undefined;
    });

    // Verify conversation context survived across runner crash and restart!
    expect(res2.text).toBe("recalled:secret-token-xyz");

    await store.appendCommand(id, { type: "stop" });
    await waitFor(async () =>
      (await store.readState(id)).status === "stopped" ? true : undefined,
    );
  });

  it("supports real tmux supervision, parent restart, reconnect, and follow-up prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-tmux-"));
    const store = new ProtocolStore(root);
    const id = workerId("realtmux1");
    cleanup.push({ root, tmuxId: id });

    // Spawn worker using Manager with real tmux
    const manager1 = new Manager({
      store,
      runnerFile: resolve("dist/runner/main.js"),
    });

    // Provide RPC child via env
    const origCommand = process.env.PI_TMUX_RPC_COMMAND;
    const origArgs = process.env.PI_TMUX_RPC_ARGS;
    process.env.PI_TMUX_RPC_COMMAND = process.execPath;
    process.env.PI_TMUX_RPC_ARGS = JSON.stringify([
      resolve("test/fixtures/fake-rpc-child.mjs"),
    ]);

    try {
      const state = await manager1.spawn({ task: "hello" }, root, id);
      expect(state.status).toBe("starting");

      // Verify tmux session actually exists
      expect(await tmuxAdapter.exists(id)).toBe(true);

      // Verify status call immediately after spawn does not orphan healthy starting worker
      const immediateStatus = await manager1.status(id);
      expect(["starting", "waiting", "running"]).toContain(
        immediateStatus.status,
      );

      // Wait for turn 1 to complete and settle into waiting
      await waitFor(async () => {
        const s = await manager1.status(id);
        return s.status === "waiting" && s.turn >= 1 ? s : undefined;
      });

      const res1 = await manager1.result(id);
      expect(res1?.text).toBe("reply-1:hello");
      expect(res1?.turn).toBe(1);

      // Invariant: parent death != worker death
      // Discard manager1 and simulate parent restart
      const manager2 = new Manager({
        store,
        runnerFile: resolve("dist/runner/main.js"),
      });

      // Reconnect and verify worker is still alive and waiting in tmux
      const reconnectedState = await manager2.status(id);
      expect(reconnectedState.status).toBe("waiting");

      // Send follow-up command: parent restart -> reconnect -> continue conversation
      await manager2.send(id, "world");

      await waitFor(async () => {
        const s = await manager2.status(id);
        return s.status === "waiting" && s.turn === 2 ? s : undefined;
      });

      const res2 = await manager2.result(id);
      expect(res2?.text).toBe("reply-2:world");
      expect(res2?.turn).toBe(2);

      // Stop worker cleanly
      await manager2.stop(id);
      await waitFor(async () => {
        const s = await manager2.status(id);
        return s.status === "stopped" ? s : undefined;
      });

      // Terminate tmux
      await manager2.forceTerminate(id);
      expect(await tmuxAdapter.exists(id)).toBe(false);
    } finally {
      if (origCommand !== undefined)
        process.env.PI_TMUX_RPC_COMMAND = origCommand;
      else delete process.env.PI_TMUX_RPC_COMMAND;
      if (origArgs !== undefined) process.env.PI_TMUX_RPC_ARGS = origArgs;
      else delete process.env.PI_TMUX_RPC_ARGS;
    }
  });
  it("applies configured thinking level to the Pi RPC worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-think-"));
    const store = new ProtocolStore(root);
    const id = workerId("think1");
    const fakeSessionFile = join(root, "session.json");
    await writeFile(fakeSessionFile, JSON.stringify({ count: 0, memory: {} }));

    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-think1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "deep problem", thinking: "high" },
        piSessionFile: fakeSessionFile,
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendCommand(id, { type: "prompt", text: "deep problem" });

    const child = spawn(
      process.execPath,
      [resolve("dist/runner/main.js"), store.dir(id)],
      {
        env: {
          ...process.env,
          PI_TMUX_RPC_COMMAND: process.execPath,
          PI_TMUX_RPC_ARGS: JSON.stringify([
            resolve("test/fixtures/fake-rpc-child.mjs"),
          ]),
        },
        stdio: "ignore",
      },
    );
    cleanup.push({ root, child });

    await waitFor(async () => {
      const res = await store.readResult(id);
      return res?.turn === 1 ? res : undefined;
    });

    // Verify thinking level was received and saved in the mock session file by fake-rpc-child
    const saved = JSON.parse(await readFile(fakeSessionFile, "utf8"));
    expect(saved.thinkingLevel).toBe("high");

    await store.appendCommand(id, { type: "stop" });
    await waitFor(async () =>
      (await store.readState(id)).status === "stopped" ? true : undefined,
    );
  });

  it("delivers compact completion notification into Pi session without streaming events, survives consumer restart, and allows lazy result fetching", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sa-notify-"));
    const store = new ProtocolStore(root);
    const manager = new Manager({ store });
    const id = workerId("notify1");

    await store.create(
      {
        version: 1,
        id,
        tmuxSession: "pi-sa-notify1",
        createdAt: new Date().toISOString(),
        cwd: root,
        launch: { task: "integration notify task" },
      },
      {
        version: 1,
        id,
        status: "starting",
        turn: 0,
        lastCommandSeq: 0,
        lastEventSeq: 0,
      },
    );
    await store.appendCommand(id, {
      type: "prompt",
      text: "task-completion-check",
    });

    const child = spawn(
      process.execPath,
      [resolve("dist/runner/main.js"), store.dir(id)],
      {
        env: {
          ...process.env,
          PI_TMUX_RPC_COMMAND: process.execPath,
          PI_TMUX_RPC_ARGS: JSON.stringify([
            resolve("test/fixtures/fake-rpc-child.mjs"),
          ]),
        },
        stdio: "ignore",
      },
    );
    cleanup.push({ root, child });

    const messages: any[] = [];
    const pi = {
      sendMessage: (msg: any) => messages.push(msg),
    };
    const notifier = new CompletionNotifier(manager, pi as any);

    // Wait for the worker to finish turn 1 in the background
    await waitFor(async () => {
      const res = await store.readResult(id);
      return res?.turn === 1 ? res : undefined;
    });

    // Main Pi session receives compact completion notification
    await notifier.poll();
    expect(messages).toHaveLength(1);
    const firstMsg = messages[0];
    expect(firstMsg.customType).toBe("subagent_completed");
    expect(firstMsg.display).toBe(true);
    expect(firstMsg.details).toEqual({
      type: "subagent_completed",
      id,
      turn: 1,
      status: "completed",
      summary: "reply-1:task-completion-check",
      hasDetails: false,
    });
    expect(firstMsg.content).toContain("[subagent notify1 completed]");
    expect(firstMsg.content).toContain("reply-1:task-completion-check");
    expect(firstMsg.content).toContain(
      'Full result available via subagent({ action: "result", id: "notify1" }).',
    );

    // Verify NO streaming events (message_update, token deltas) were sent into sendMessage
    for (const msg of messages) {
      expect(msg.customType).not.toBe("message_update");
      expect(JSON.stringify(msg)).not.toContain("text_delta");
    }

    // Main agent can subsequently call manager.result(id) to fetch full details
    const fullResult = await manager.result(id);
    expect(fullResult?.text).toBe("reply-1:task-completion-check");

    // Extension restart simulation: new notifier does not redeliver already acknowledged completions
    const restartedMessages: any[] = [];
    const restartedNotifier = new CompletionNotifier(
      new Manager({ store: new ProtocolStore(root) }),
      { sendMessage: (msg: any) => restartedMessages.push(msg) } as any,
    );
    await restartedNotifier.poll();
    expect(restartedMessages).toHaveLength(0);

    // Clean stop
    await store.appendCommand(id, { type: "stop" });
    await waitFor(async () =>
      (await store.readState(id)).status === "stopped" ? true : undefined,
    );
  });
});
