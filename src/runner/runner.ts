import { ProtocolStore } from "../protocol/store.js";
import { assistantText } from "../protocol/events.js";
import { reduceEvents } from "../protocol/state.js";
import type { WorkerCommand, WorkerEvent } from "../protocol/types.js";
import { RpcClient } from "./rpc-client.js";
import { renderRpcEvent } from "./renderer.js";
import type { WorkerId } from "../types.js";
import { WorktreeAdapter } from "../worktree/adapter.js";

export interface RunnerOptions { pollMs?: number; heartbeatMs?: number; rpcCommand?: string; rpcArgs?: string[]; output?: NodeJS.WritableStream }
export class Runner {
  private stopped = false; private latestText = ""; private heartbeat?: NodeJS.Timeout; private recordQueue: Promise<void> = Promise.resolve();
  private readonly store: ProtocolStore; private readonly id: WorkerId; private rpc!: RpcClient;
  constructor(private readonly runDir: string, private readonly options: RunnerOptions = {}) {
    const parts = runDir.split(/[\\/]/); this.id = parts[parts.length - 1] as WorkerId;
    this.store = new ProtocolStore(parts.slice(0, -1).join("/") || "/");
  }
  async run(): Promise<void> {
    let meta = await this.store.readMeta(this.id);
    const launchArgs = ["--mode", "rpc", ...(meta.launch.model ? ["--model", meta.launch.model] : []), ...(meta.launch.name ? ["--name", meta.launch.name] : []), ...(meta.launch.systemPrompt ? ["--system-prompt", meta.launch.systemPrompt] : []), ...(meta.launch.tools ? ["--tools", meta.launch.tools.join(",")] : []), ...(meta.launch.rpcArgs ?? [])];
    this.rpc = new RpcClient({ cwd: meta.cwd, ...(this.options.rpcCommand ? { command: this.options.rpcCommand } : {}), args: this.options.rpcArgs ?? launchArgs });
    meta = { ...meta, runnerPid: process.pid, heartbeatAt: new Date().toISOString() }; await this.store.writeMeta(meta);
    this.rpc.on("stderr", (text) => { void this.store.appendRunnerLog(this.id, String(text)); });
    this.rpc.on("event", (event) => { void this.onRpc(event); });
    this.rpc.on("error", (error) => { void this.fail(error); });
    this.rpc.on("exit", (data) => { if (!this.stopped) void this.fail(data); });
    this.rpc.start();
    meta = { ...meta, ...(this.rpc.pid ? { piPid: this.rpc.pid } : {}), heartbeatAt: new Date().toISOString() }; await this.store.writeMeta(meta);
    await this.record({ type: "rpc_started", data: { piPid: this.rpc.pid } });
    this.heartbeat = setInterval(() => { void this.touch(); }, this.options.heartbeatMs ?? 2_000);
    while (!this.stopped) { await this.consume(); await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100)); }
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
  private async touch(): Promise<void> { const meta = await this.store.readMeta(this.id); await this.store.writeMeta({ ...meta, heartbeatAt: new Date().toISOString(), runnerPid: process.pid, ...(this.rpc.pid ? { piPid: this.rpc.pid } : {}) }); }
  async consume(): Promise<void> {
    const [commands, events] = await Promise.all([this.store.readLog<WorkerCommand>(this.id, "commands"), this.store.readLog<WorkerEvent>(this.id, "events")]);
    const acked = new Set(events.filter((x) => x.type === "command_ack").map((x) => x.commandSeq));
    for (const command of commands) if (!acked.has(command.seq)) await this.execute(command);
  }
  private async execute(command: WorkerCommand): Promise<void> {
    if (command.type === "prompt") await this.rpc.prompt(command.text);
    else if (command.type === "send") await this.rpc.prompt(command.text, "followUp");
    else if (command.type === "steer") await this.rpc.steer(command.text);
    else if (command.type === "abort") await this.rpc.abort();
    else if (command.type === "stop") { await this.rpc.abort().catch(() => undefined); this.stopped = true; this.rpc.stop(); }
    await this.record({ type: "command_ack", commandSeq: command.seq });
    if (command.type === "stop") await this.record({ type: "stopped" });
  }
  private async onRpc(event: any): Promise<void> {
    const display = renderRpcEvent(event); if (display) (this.options.output ?? process.stdout).write(display);
    const text = assistantText(event); if (text !== undefined) this.latestText = text;
    await this.record({ type: event.type, data: event });
    if (event.type === "agent_settled" && this.latestText) {
      const state = await this.store.readState(this.id);
      const meta = await this.store.readMeta(this.id);
      const workspace = meta.workspace?.mode === "worktree" ? await new WorktreeAdapter().inspect(meta.workspace).catch(() => meta.workspace) : meta.workspace;
      await this.store.writeResult({ version: 1, id: this.id, text: this.latestText, completedAt: new Date().toISOString(), eventSeq: state.lastEventSeq, ...(workspace ? { workspace } : {}) });
    }
  }
  private record(value: Omit<WorkerEvent, "version" | "seq" | "at">): Promise<void> {
    const operation = this.recordQueue.then(async () => {
      const event = await this.store.appendEvent(this.id, value); const current = await this.store.readState(this.id);
      await this.store.writeState(reduceEvents(current, [event]));
    });
    this.recordQueue = operation.catch(() => undefined); return operation;
  }
  private async fail(error: unknown): Promise<void> { await this.record({ type: "failed", data: error instanceof Error ? error.message : error }); this.stopped = true; }
}
