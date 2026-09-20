import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { SubagentError, type WorkerId } from "../types.js";

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Executor = (command: string, args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>;
export type InteractiveExecutor = (command: string, args: readonly string[], options?: { cwd?: string }) => Promise<number>;

export const execFile: Executor = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

export const defaultInteractiveExec: InteractiveExecutor = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options?.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

export function sessionName(id: WorkerId | string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(id)) throw new SubagentError("INVALID_WORKER_ID", `Invalid worker id: ${id}`);
  return `pi-sa-${id}`;
}

export class TmuxAdapter {
  constructor(
    private readonly exec: Executor = execFile,
    private readonly interactiveExec: InteractiveExecutor = defaultInteractiveExec,
  ) {}

  async available(): Promise<boolean> {
    try { return (await this.exec("tmux", ["-V"])).code === 0; } catch { return false; }
  }
  async exists(id: WorkerId | string): Promise<boolean> {
    const result = await this.exec("tmux", ["has-session", "-t", `=${sessionName(id)}`]);
    return result.code === 0;
  }
  async list(): Promise<string[]> {
    const result = await this.exec("tmux", ["list-sessions", "-F", "#{session_name}"]);
    if (result.code !== 0) return [];
    return result.stdout.split("\n").filter((name) => name.startsWith("pi-sa-"));
  }
  async create(
    id: WorkerId | string,
    runDir: string,
    runnerFile: string,
    node = process.execPath,
    cwd = runDir,
    customEnv: Record<string, string> = {},
  ): Promise<string> {
    await access(runnerFile);
    const name = sessionName(id);
    if (await this.exists(id)) throw new SubagentError("SESSION_EXISTS", `tmux session already exists: ${name}`);
    const allEnv = { ...process.env, ...customEnv };
    const environment = [
      "PI_TMUX_REGISTRY",
      "PI_TMUX_RPC_COMMAND",
      "PI_TMUX_RPC_ARGS",
      "PI_TMUX_DEPTH",
      "PI_TMUX_MAX_DEPTH",
    ].flatMap((key) => allEnv[key] === undefined ? [] : ["-e", `${key}=${allEnv[key]}`]);
    const result = await this.exec("tmux", ["new-session", "-d", "-s", name, "-c", cwd, ...environment, node, runnerFile, runDir]);
    if (result.code !== 0) throw new SubagentError("TMUX_CREATE_FAILED", result.stderr.trim() || `Could not create ${name}`);
    return name;
  }
  attachArgs(id: WorkerId | string): string[] { return ["attach-session", "-t", `=${sessionName(id)}`]; }
  async attach(id: WorkerId | string): Promise<void> {
    const code = await this.interactiveExec("tmux", this.attachArgs(id));
    if (code !== 0) throw new SubagentError("TMUX_ATTACH_FAILED", `tmux attach failed with exit code ${code}`);
  }
  async terminate(id: WorkerId | string): Promise<void> {
    const result = await this.exec("tmux", ["kill-session", "-t", `=${sessionName(id)}`]);
    if (result.code !== 0 && !/can't find session/i.test(result.stderr)) throw new SubagentError("TMUX_TERMINATE_FAILED", result.stderr.trim());
  }
}
