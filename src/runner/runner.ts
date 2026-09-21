import { ProtocolStore } from "../protocol/store.js";
import { assistantText } from "../protocol/events.js";
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
import { normalizeRpcEvent } from "./renderer.js";
import { SubagentMonitor } from "./monitor.js";
import type { WorkerId } from "../types.js";
import { WorktreeAdapter } from "../worktree/adapter.js";

interface ActiveTurnContext {
  turn: number;
  initiatingCommandSeq?: number;
  relatedCommandSeqs: number[];
  startedAt: string;
}

export interface RunnerOptions {
  pollMs?: number;
  heartbeatMs?: number;
  unresponsiveMs?: number;
  rpcCommand?: string;
  rpcArgs?: string[];
  output?: NodeJS.WritableStream;
  columns?: number;
  rows?: number;
}

export class Runner {
  private stopped = false;
  private failed = false;
  private turnText = "";
  private currentTurn = 0;
  private activeTurn: ActiveTurnContext | undefined;
  private monitor!: SubagentMonitor;
  private readonly pendingTurnCommandSeqs: number[] = [];
  private inFlightCommand: { seq: number; startedAt: number } | undefined;
  private isUnresponsive = false;
  private lastTurnActivityAt: number | undefined;
  private lastProcessedCommandSeq = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private recordQueue: Promise<void> = Promise.resolve();
  private rpcEventQueue: Promise<void> = Promise.resolve();
  private failQueue: Promise<void> = Promise.resolve();
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

    this.monitor = new SubagentMonitor({
      id: this.id,
      name: meta.launch.name,
      agent: meta.launch.agent,
      provider: meta.launch.provider,
      model: meta.launch.model,
      thinking: meta.launch.thinking,
      status: state?.status ?? "starting",
      turn: this.currentTurn,
      startedAt: meta.createdAt,
      output: this.options.output ?? process.stdout,
      columns: this.options.columns,
      rows: this.options.rows,
    });
    this.monitor.start();

    const events = await this.store
      .readLog<WorkerEvent>(this.id, "events")
      .catch(() => []);

    if (state && state.turn > 0) {
      const lastResult = await this.store
        .readResult(this.id)
        .catch(() => undefined);
      if (lastResult && lastResult.turn === state.turn) {
        const lastCompletion = await this.store
          .readCompletion(this.id)
          .catch(() => undefined);
        if (!lastCompletion || lastCompletion.turn !== state.turn) {
          await this.store
            .writeCompletion(completedNotification(lastResult))
            .catch(() => undefined);
        }
      } else if (!lastResult || lastResult.turn < state.turn) {
        await this.record({
          type: "turn_interrupted",
          data: "Turn interrupted by runner crash/restart",
        }).catch(() => undefined);
        const currentState = await this.store
          .readState(this.id)
          .catch(() => undefined);
        const resultSeq = currentState?.lastEventSeq ?? state.lastEventSeq;

        // Recover initiating command from durable turn context, not lastCommandSeq
        const lastAgentStart = [...events]
          .reverse()
          .find((e) => e.type === "agent_start");
        const initiatingCommandSeq =
          (lastAgentStart?.data as any)?.turnContext?.initiatingCommandSeq ??
          lastAgentStart?.commandSeq ??
          (state.lastCommandSeq > 0 ? state.lastCommandSeq : undefined);

        const failedResult: WorkerResult = {
          version: 1,
          id: this.id,
          status: "failed",
          turn: state.turn,
          ...(initiatingCommandSeq !== undefined
            ? { commandSeq: initiatingCommandSeq }
            : {}),
          resultSeq,
          eventSeq: resultSeq,
          text: "Turn interrupted by runner crash/restart",
          completedAt: new Date().toISOString(),
          ...(meta.workspace ? { workspace: meta.workspace } : {}),
        };
        await this.store.writeResult(failedResult).catch(() => undefined);
        await this.store
          .writeCompletion({
            version: 1,
            kind: "turn",
            id: this.id,
            turn: state.turn,
            ...(initiatingCommandSeq !== undefined
              ? { commandSeq: initiatingCommandSeq }
              : {}),
            resultSeq,
            status: "failed",
            summary: completionSummary(
              "Turn interrupted by runner crash/restart",
            ),
            hasDetails: true,
            completedAt: failedResult.completedAt,
          })
          .catch(() => undefined);
      }
    }

    // Recover commands acknowledged by RPC before crash but whose turn never started
    const commands = await this.store
      .readLog<WorkerCommand>(this.id, "commands")
      .catch(() => []);
    const ackedCmdSeqs = new Set(
      events
        .filter((e) => e.type === "command_ack" && e.commandSeq)
        .map((e) => e.commandSeq!),
    );
    const turnInitiatingCmds = commands.filter(
      (cmd) =>
        (cmd.type === "prompt" || cmd.type === "send") &&
        ackedCmdSeqs.has(cmd.seq),
    );
    const startedCount = events.filter((e) => e.type === "agent_start").length;
    const unstartedCmds = turnInitiatingCmds.slice(startedCount);

    for (const cmd of unstartedCmds) {
      const unstartedTurn = Math.max(state?.turn ?? 0, this.currentTurn) + 1;
      this.currentTurn = unstartedTurn;
      await this.record({
        type: "turn_interrupted",
        commandSeq: cmd.seq,
        data: "Turn interrupted before start by runner crash/restart",
      }).catch(() => undefined);
      const currentState = await this.store
        .readState(this.id)
        .catch(() => undefined);
      const resultSeq = currentState?.lastEventSeq ?? 0;
      const failedResult: WorkerResult = {
        version: 1,
        id: this.id,
        status: "failed",
        turn: unstartedTurn,
        commandSeq: cmd.seq,
        resultSeq,
        eventSeq: resultSeq,
        text: "Turn interrupted before start by runner crash/restart",
        completedAt: new Date().toISOString(),
        ...(meta.workspace ? { workspace: meta.workspace } : {}),
      };
      await this.store.writeResult(failedResult).catch(() => undefined);
      await this.store
        .writeCompletion({
          version: 1,
          kind: "turn",
          id: this.id,
          turn: unstartedTurn,
          commandSeq: cmd.seq,
          resultSeq,
          status: "failed",
          summary: completionSummary(
            "Turn interrupted before start by runner crash/restart",
          ),
          hasDetails: true,
          completedAt: failedResult.completedAt,
        })
        .catch(() => undefined);
      this.lastProcessedCommandSeq = Math.max(
        this.lastProcessedCommandSeq,
        cmd.seq,
      );
    }

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
      ...(process.env.TMUX_PANE ? { tmuxPane: process.env.TMUX_PANE } : {}),
      runnerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
    };
    await this.store.writeMeta(meta);

    this.rpc.on("stderr", (text) => {
      void this.store.appendRunnerLog(this.id, String(text));
    });
    this.rpc.on("event", (event) => {
      this.rpcEventQueue = this.rpcEventQueue
        .then(() => this.onRpc(event))
        .catch((error) => {
          void this.failOnce(error);
        });
    });
    this.rpc.on("error", (error) => {
      void this.failOnce(error);
    });
    this.rpc.on("exit", (data) => {
      if (!this.stopped) void this.failOnce(data);
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

    this.monitor.updateMeta({
      activeModel,
      provider: activeModel.provider,
      model: activeModel.model,
      thinking: activeModel.thinking,
    });

    await this.record({ type: "rpc_started", data: { piPid: this.rpc.pid } });
    this.heartbeat = setInterval(() => {
      void this.touch();
    }, this.options.heartbeatMs ?? 2_000);

    try {
      while (!this.stopped) {
        await this.consume();
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.pollMs ?? 100),
        );
      }
    } catch (error) {
      await this.failOnce(error);
    } finally {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
      this.rpc?.stop();
      this.monitor?.stop();
    }
  }

  private async touch(): Promise<void> {
    const meta = await this.store.readMeta(this.id);
    await this.store.writeMeta({
      ...meta,
      heartbeatAt: new Date().toISOString(),
      runnerPid: process.pid,
      ...(this.rpc.pid ? { piPid: this.rpc.pid } : {}),
      ...(this.inFlightCommand
        ? {
            inFlightCommand: {
              seq: this.inFlightCommand.seq,
              startedAt: new Date(this.inFlightCommand.startedAt).toISOString(),
            },
          }
        : {}),
    });

    this.monitor?.tick();

    const threshold = this.options.unresponsiveMs ?? 10_000;
    if (
      this.inFlightCommand &&
      !this.isUnresponsive &&
      Date.now() - this.inFlightCommand.startedAt >= threshold
    ) {
      this.isUnresponsive = true;
      this.monitor?.updateStatus("unresponsive");
      await this.record({
        type: "unresponsive",
        commandSeq: this.inFlightCommand.seq,
        data: `RPC command ${this.inFlightCommand.seq} unresponsive after ${Date.now() - this.inFlightCommand.startedAt}ms`,
      }).catch(() => undefined);
    } else if (
      this.activeTurn &&
      this.lastTurnActivityAt !== undefined &&
      !this.isUnresponsive &&
      Date.now() - this.lastTurnActivityAt >= threshold
    ) {
      this.isUnresponsive = true;
      this.monitor?.updateStatus("unresponsive");
      await this.record({
        type: "unresponsive",
        ...(this.activeTurn.initiatingCommandSeq !== undefined
          ? { commandSeq: this.activeTurn.initiatingCommandSeq }
          : {}),
        data: `Active turn ${this.activeTurn.turn} unresponsive after ${Date.now() - this.lastTurnActivityAt}ms`,
      }).catch(() => undefined);
    }
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
    if (command.type === "prompt" || command.type === "send") {
      // Queue before calling RPC because agent_start may arrive before the RPC
      // request promise resolves. It is consumed only when that turn starts.
      this.pendingTurnCommandSeqs.push(command.seq);
      this.inFlightCommand = { seq: command.seq, startedAt: Date.now() };
      try {
        if (command.type === "prompt") await this.rpc.prompt(command.text);
        else await this.rpc.prompt(command.text, "followUp");
        this.inFlightCommand = undefined;
      } catch (error) {
        const index = this.pendingTurnCommandSeqs.indexOf(command.seq);
        if (index >= 0) this.pendingTurnCommandSeqs.splice(index, 1);
        throw error;
      }
    } else if (command.type === "steer") {
      await this.rpc.steer(command.text);
      await this.recordRelatedCommand(command);
    } else if (command.type === "abort") {
      await this.rpc.abort();
      await this.recordRelatedCommand(command);
    } else if (command.type === "stop") {
      await this.rpc.abort().catch(() => undefined);
      this.stopped = true;
      this.monitor?.updateStatus("stopped");
      this.rpc.stop();
    }
    await this.record({ type: "command_ack", commandSeq: command.seq });
    if (command.type === "stop") await this.record({ type: "stopped" });
  }

  private async onRpc(event: any): Promise<void> {
    this.lastTurnActivityAt = Date.now();
    if (this.isUnresponsive) {
      this.isUnresponsive = false;
      this.monitor?.updateStatus("running");
      await this.record({
        type: "responsive",
        data: "RPC worker resumed responding",
      }).catch(() => undefined);
    }

    const presentation = normalizeRpcEvent(event);
    if (presentation) {
      this.monitor?.handleEvent(presentation);
    }

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
      this.monitor?.updateStatus("running", this.currentTurn);
      const initiatingCommandSeq = this.pendingTurnCommandSeqs.shift();
      this.activeTurn = {
        turn: this.currentTurn,
        ...(initiatingCommandSeq !== undefined ? { initiatingCommandSeq } : {}),
        relatedCommandSeqs: [],
        startedAt: new Date().toISOString(),
      };
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
      data:
        event.type === "agent_start"
          ? { rpcEvent: event, turnContext: this.activeTurn }
          : event,
      ...(this.activeTurn?.initiatingCommandSeq !== undefined
        ? { commandSeq: this.activeTurn.initiatingCommandSeq }
        : {}),
    });

    if (event.type === "agent_settled") {
      this.monitor?.updateStatus("waiting", this.currentTurn);
      this.lastTurnActivityAt = undefined;
      const completedTurnContext = this.activeTurn;
      const completedText = this.turnText;
      const completedTurnNumber = this.currentTurn;
      this.activeTurn = undefined;

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
        turn: completedTurnNumber,
        ...(completedTurnContext?.initiatingCommandSeq !== undefined
          ? { commandSeq: completedTurnContext.initiatingCommandSeq }
          : {}),
        text: completedText,
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

  private async recordRelatedCommand(command: WorkerCommand): Promise<void> {
    if (!this.activeTurn) return;
    this.activeTurn.relatedCommandSeqs.push(command.seq);
    await this.record({
      type: "turn_command_related",
      ...(this.activeTurn.initiatingCommandSeq !== undefined
        ? { commandSeq: this.activeTurn.initiatingCommandSeq }
        : {}),
      data: {
        turn: this.activeTurn.turn,
        initiatingCommandSeq: this.activeTurn.initiatingCommandSeq,
        relatedCommandSeq: command.seq,
        commandType: command.type,
      },
    });
  }

  private record(
    value: Omit<WorkerEvent, "version" | "seq" | "at">,
  ): Promise<void> {
    const operation = this.recordQueue.then(async () => {
      await this.store.appendEventAndProjectState(this.id, value);
    });
    this.recordQueue = operation.catch(() => undefined);
    return operation;
  }

  private failOnce(error: unknown): Promise<void> {
    const operation = this.failQueue.then(async () => {
      if (this.failed) return;
      this.failed = true;
      this.stopped = true;
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.monitor?.updateStatus("failed");
      this.monitor?.handleEvent({ kind: "error", message });
      await this.record({ type: "failed", data: message }).catch(
        () => undefined,
      );
      const state = await this.store.readState(this.id).catch(() => undefined);
      const meta = await this.store.readMeta(this.id).catch(() => undefined);
      const turn = state?.turn ?? this.currentTurn;
      const resultSeq = state?.lastEventSeq ?? 0;
      const completedAt = state?.lastEventAt ?? new Date().toISOString();
      const hasActiveTurn = Boolean(this.activeTurn || this.inFlightCommand);
      const commandSeq =
        this.activeTurn?.initiatingCommandSeq ?? this.inFlightCommand?.seq;

      if (hasActiveTurn) {
        await this.store
          .writeResult({
            version: 1,
            id: this.id,
            status: "failed",
            turn,
            ...(commandSeq !== undefined ? { commandSeq } : {}),
            resultSeq,
            eventSeq: resultSeq,
            text: message || "Worker failed.",
            completedAt,
            ...(meta?.workspace ? { workspace: meta.workspace } : {}),
          })
          .catch(() => undefined);

        await this.store
          .writeCompletion({
            version: 1,
            kind: "turn",
            id: this.id,
            turn,
            ...(commandSeq !== undefined ? { commandSeq } : {}),
            resultSeq,
            status: "failed",
            summary: completionSummary(message || "Worker failed."),
            hasDetails: true,
            completedAt,
          })
          .catch(() => undefined);
      } else {
        // Idle worker death: do NOT overwrite previous turn result! Emit worker lifecycle notification.
        await this.store
          .writeCompletion({
            version: 1,
            kind: "worker",
            id: this.id,
            turn,
            resultSeq,
            status: "failed",
            summary: completionSummary(message || "Worker failed."),
            hasDetails: false,
            completedAt,
          })
          .catch(() => undefined);
      }

      this.rpc?.stop();
    });
    this.failQueue = operation.catch(() => undefined);
    return operation;
  }
}
