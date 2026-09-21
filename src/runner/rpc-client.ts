import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { SubagentError } from "../types.js";

export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  push(chunk: Buffer | string): unknown[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const records: unknown[] = [];
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) records.push(JSON.parse(line));
    }
    return records;
  }
  end(): unknown[] {
    this.buffer += this.decoder.end();
    if (!this.buffer) return [];
    const line = this.buffer.endsWith("\r")
      ? this.buffer.slice(0, -1)
      : this.buffer;
    this.buffer = "";
    return line ? [JSON.parse(line)] : [];
  }
}

export interface RpcClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export class RpcClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private request = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly options: RpcClientOptions) {
    super();
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }
  start(): void {
    if (this.child)
      throw new SubagentError(
        "RPC_ALREADY_STARTED",
        "RPC child is already started",
      );
    const child = spawn(
      this.options.command ?? "pi",
      this.options.args ?? ["--mode", "rpc"],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    const decoder = new JsonlDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) this.handle(value);
      } catch (error) {
        this.emit(
          "error",
          new SubagentError(
            "RPC_PARSE_FAILED",
            "Invalid JSON from Pi RPC",
            error,
          ),
        );
      }
    });
    child.stdout.on("end", () => {
      try {
        for (const value of decoder.end()) this.handle(value);
      } catch (error) {
        this.emit("error", error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) =>
      this.emit("stderr", chunk.toString("utf8")),
    );
    child.on("error", (error) =>
      this.emit(
        "error",
        new SubagentError("RPC_START_FAILED", error.message, error),
      ),
    );
    child.on("close", (code, signal) => {
      const error = new SubagentError(
        "RPC_EXITED",
        `Pi RPC exited (code=${String(code)}, signal=${String(signal)})`,
      );
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      this.emit("exit", { code, signal });
    });
  }
  private handle(value: any): void {
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      this.emit(
        "error",
        new SubagentError(
          "RPC_SCHEMA_INVALID",
          "RPC record must be an object with a type",
        ),
      );
      return;
    }
    if (
      value.type === "response" &&
      typeof value.id === "string" &&
      this.pending.has(value.id)
    ) {
      const pending = this.pending.get(value.id)!;
      this.pending.delete(value.id);
      if (value.success) pending.resolve(value);
      else
        pending.reject(
          new SubagentError(
            "RPC_COMMAND_FAILED",
            String(value.error ?? value.command),
          ),
        );
    }
    this.emit("event", value);
  }
  notify(command: Record<string, unknown>): Promise<void> {
    if (!this.child?.stdin.writable)
      return Promise.reject(
        new SubagentError("RPC_NOT_RUNNING", "RPC child is not running"),
      );
    return new Promise((resolve, reject) => {
      this.child!.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  send(command: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    if (command.type === "extension_ui_response") {
      return this.notify(command);
    }
    if (!this.child?.stdin.writable)
      return Promise.reject(
        new SubagentError("RPC_NOT_RUNNING", "RPC child is not running"),
      );
    const id =
      typeof command.id === "string" ? command.id : `cmd-${++this.request}`;
    const timeout = timeoutMs ?? this.options.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeout && timeout > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(
              new SubagentError(
                "RPC_REQUEST_TIMEOUT",
                `RPC request ${id} timed out after ${timeout}ms`,
              ),
            );
          }
        }, timeout);
        timer.unref?.();
      }
      this.pending.set(id, {
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      this.child!.stdin.write(
        `${JSON.stringify({ ...command, id })}\n`,
        (error) => {
          if (error) {
            if (timer) clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<any> {
    return this.send({
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }
  steer(message: string): Promise<any> {
    return this.send({ type: "steer", message });
  }
  abort(): Promise<any> {
    return this.send({ type: "abort" });
  }
  getState(): Promise<any> {
    return this.send({ type: "get_state" });
  }
  setThinkingLevel(level: string): Promise<any> {
    return this.send({ type: "set_thinking_level", level });
  }
  switchSession(sessionPath: string): Promise<any> {
    return this.send({ type: "switch_session", sessionPath });
  }
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal);
  }
}
