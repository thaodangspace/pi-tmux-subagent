import { ProtocolStore } from "../protocol/store.js";
import { assistantText } from "../protocol/events.js";
import { reduceEvents } from "../protocol/state.js";
import {
  completedNotification,
  completionSummary,
} from "../protocol/completion.js";
import type {
  WorkerCommand,
  WorkerEvent,
  WorkerResult,
} from "../protocol/types.js";
import { RpcClient } from "./rpc-client.js";
import { renderRpcEvent } from "./renderer.js";
import type { WorkerId } from "../types.js";
import { WorktreeAdapter } from "../worktree/adapter.js";

export interface RunnerOptions {
  pollMs?: number;
  heartbeatMs?: number;
  rpcCommand?: string;
  rpcArgs?: string[];
  output?: NodeJS.WritableStream;
}

export class Runner {
  private stopped = false;
  private turnText = "";
  private currentTurn = 0;
  private activeCommandSeq?: number;
  private lastProcessedCommandSeq = 0;
  private heartbeat?: NodeJS.Timeout;
  private recordQueue: Promise<void> = Promise.resolve();
  private readonly store: ProtocolStore;
  private readonly id: WorkerId;
  private rpc!: RpcClient;

  constructor(
    private readonly runDir: string,
    private readonly options: RunnerOptions = {},
  ) {
    const parts = runDir.split(/[\\/]/);
    this.id = parts[parts.length - 1] as WorkerId;
    this.store = new ProtocolStore(parts.slice(0, -1).join("/") || "/");
  }

  async run(): Promise<void> {
    let meta = await this.store.readMeta(this.id);
    const state = await this.store.readState(this.id).catch(() => undefined);
    this.lastProcessedCommandSeq = state?.lastCommandSeq ?? 0;
    this.currentTurn = state?.turn ?? 0;

    const sessionArgs = meta.piSessionFile
      ? ["--session", meta.piSessionFile]
      : meta.piSessionId
        ? ["--session-id", meta.piSessionId]
        : [];

    const launchArgs = [
      "--mode",
      "rpc",
      ...(meta.launch.provider ? ["--provider", meta.launch.provider] : []),
      ...(meta.launch.model ? ["--model", meta.launch.model] : []),
      ...(meta.launch.thinking ? ["--thinking", meta.launch.thinking] : []),
      ...(meta.launch.name ? ["--name", meta.launch.name] : []),
      ...(meta.launch.systemPrompt
        ? ["--system-prompt", meta.launch.systemPrompt]
        : []),
      ...(meta.launch.tools ? ["--tools", meta.launch.tools.join(",")] : []),
      ...sessionArgs,
      ...(meta.launch.rpcArgs ?? []),
    ];

    const baseArgs = this.options.rpcArgs ?? [];
    this.rpc = new RpcClient({
      cwd: meta.cwd,
      ...(this.options.rpcCommand ? { command: this.options.rpcCommand } : {}),
      args: [...baseArgs, ...launchArgs],
    });

    meta = {
      ...meta,
      runnerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
    };
    await this.store.writeMeta(meta);

    this.rpc.on("stderr", (text) => {
      void this.store.appendRunnerLog(this.id, String(text));
    });
    this.rpc.on("event", (event) => {
      void this.onRpc(event);
    });
    this.rpc.on("error", (error) => {
      void this.fail(error);
    });
    this.rpc.on("exit", (data) => {
      if (!this.stopped) void this.fail(data);
    });
    this.rpc.start();

    if (meta.launch.thinking) {
      await this.rpc
        .setThinkingLevel(meta.launch.thinking)
        .catch(() => undefined);
    }

    const rpcState = await this.rpc.getState().catch(() => undefined);
    const stateData = rpcState?.data ?? rpcState;
    const piSessionFile = stateData?.sessionFile ?? meta.piSessionFile;
    const piSessionId = stateData?.sessionId ?? meta.piSessionId;
    const activeModel = {
      ...(stateData?.model?.provider
        ? { provider: String(stateData.model.provider) }
        : meta.launch.provider
          ? { provider: meta.launch.provider }
          : {}),
      ...(stateData?.model?.id
        ? { model: String(stateData.model.id) }
        : meta.launch.model
          ? { model: meta.launch.model }
          : {}),
      ...(stateData?.thinkingLevel
        ? { thinking: String(stateData.thinkingLevel) }
        : meta.launch.thinking
          ? { thinking: meta.launch.thinking }
          : {}),
    };

    if (
      meta.piSessionFile &&
      stateData?.sessionFile &&
      stateData.sessionFile !== meta.piSessionFile
    ) {
      await this.rpc.switchSession(meta.piSessionFile).catch(() => undefined);
    }

    meta = {
      ...meta,
      runnerPid: process.pid,
      ...(this.rpc.pid ? { piPid: this.rpc.pid } : {}),
      heartbeatAt: new Date().toISOString(),
      ...(piSessionFile ? { piSessionFile } : {}),
      ...(piSessionId ? { piSessionId } : {}),
      ...(Object.keys(activeModel).length ? { activeModel } : {}),
    };
    await this.store.writeMeta(meta);

    await this.record({ type: "rpc_started", data: { piPid: this.rpc.pid } });
    this.heartbeat = setInterval(() => {
      void this.touch();
    }, this.options.heartbeatMs ?? 2_000);

    while (!this.stopped) {
      await this.consume();
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.pollMs ?? 100),
      );
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  private async touch(): Promise<void> {
    const meta = await this.store.readMeta(this.id);
    await this.store.writeMeta({
      ...meta,
      heartbeatAt: new Date().toISOString(),
      runnerPid: process.pid,
      ...(this.rpc.pid ? { piPid: this.rpc.pid } : {}),
    });
  }

  async consume(): Promise<void> {
    const commands = await this.store.readLog<WorkerCommand>(
      this.id,
      "commands",
      this.lastProcessedCommandSeq + 1,
    );
    for (const command of commands) {
      if (command.seq > this.lastProcessedCommandSeq) {
        await this.execute(command);
        this.lastProcessedCommandSeq = command.seq;
      }
    }
  }

  private async execute(command: WorkerCommand): Promise<void> {
    this.activeCommandSeq = command.seq;
    if (command.type === "prompt") await this.rpc.prompt(command.text);
    else if (command.type === "send")
      await this.rpc.prompt(command.text, "followUp");
    else if (command.type === "steer") await this.rpc.steer(command.text);
    else if (command.type === "abort") await this.rpc.abort();
    else if (command.type === "stop") {
      await this.rpc.abort().catch(() => undefined);
      this.stopped = true;
      this.rpc.stop();
    }
    await this.record({ type: "command_ack", commandSeq: command.seq });
    if (command.type === "stop") await this.record({ type: "stopped" });
  }

  private async onRpc(event: any): Promise<void> {
    const display = renderRpcEvent(event);
    if (display) (this.options.output ?? process.stdout).write(display);

    if (event.type === "extension_ui_request" && event.id) {
      await this.rpc
        .send({
          type: "extension_ui_response",
          id: event.id,
          cancelled: true,
        })
        .catch(() => undefined);
    }

    if (event.type === "agent_start") {
      this.turnText = "";
      this.currentTurn += 1;
    }

    const text = assistantText(event);
    if (text !== undefined) {
      this.turnText = text;
    }

    // Coalesce/avoid high-frequency streaming events that are only useful for human rendering
    if (event.type === "message_update") {
      return;
    }

    await this.record({
      type: event.type,
      data: event,
      ...(this.activeCommandSeq !== undefined
        ? { commandSeq: this.activeCommandSeq }
        : {}),
    });

    if (event.type === "agent_settled") {
      const state = await this.store.readState(this.id);
      const meta = await this.store.readMeta(this.id);
      const workspace =
        meta.workspace?.mode === "worktree"
          ? await new WorktreeAdapter()
              .inspect(meta.workspace)
              .catch(() => meta.workspace)
          : meta.workspace;
      const result: WorkerResult = {
        version: 1,
        id: this.id,
        status: "completed",
        turn: this.currentTurn,
        ...(this.activeCommandSeq !== undefined
          ? { commandSeq: this.activeCommandSeq }
          : {}),
        text: this.turnText,
        completedAt: new Date().toISOString(),
        resultSeq: state.lastEventSeq,
        eventSeq: state.lastEventSeq,
        ...(workspace ? { workspace } : {}),
      };
      // The complete response is durable before its compact notification is published.
      await this.store.writeResult(result);
      await this.store.writeCompletion(completedNotification(result));
    }
  }

  private record(
    value: Omit<WorkerEvent, "version" | "seq" | "at">,
  ): Promise<void> {
    const operation = this.recordQueue.then(async () => {
      const event = await this.store.appendEvent(this.id, value);
      const current = await this.store.readState(this.id);
      await this.store.writeState(reduceEvents(current, [event]));
    });
    this.recordQueue = operation.catch(() => undefined);
    return operation;
  }

  private async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.record({ type: "failed", data: message });
    const state = await this.store.readState(this.id);
    const meta = await this.store.readMeta(this.id);
    await this.store.writeResult({
      version: 1,
      id: this.id,
      status: "failed",
      turn: state.turn,
      ...(this.activeCommandSeq !== undefined
        ? { commandSeq: this.activeCommandSeq }
        : {}),
      resultSeq: state.lastEventSeq,
      eventSeq: state.lastEventSeq,
      text: message || "Worker failed.",
      completedAt: state.lastEventAt ?? new Date().toISOString(),
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
    });
    await this.store.writeCompletion({
      version: 1,
      id: this.id,
      turn: state.turn,
      ...(this.activeCommandSeq !== undefined
        ? { commandSeq: this.activeCommandSeq }
        : {}),
      resultSeq: state.lastEventSeq,
      status: "failed",
      summary: completionSummary(message || "Worker failed."),
      hasDetails: true,
      completedAt: state.lastEventAt ?? new Date().toISOString(),
    });
    this.stopped = true;
  }
}
