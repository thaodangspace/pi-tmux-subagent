import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { LaunchConfig, WorkspaceMode } from "../protocol/types.js";
import { SubagentError } from "../types.js";

export interface AgentDefinition {
  name: string;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  workspace?: WorkspaceMode;
  spawning?: boolean;
  maxDepth?: number;
  systemPrompt: string;
  path: string;
}

export interface ModelSelection { provider: string; model: string; thinking?: string }
export interface AgentConfig {
  models: ModelSelection[];
  default?: ModelSelection;
}

function isSelection(value: unknown): value is ModelSelection {
  return Boolean(value && typeof value === "object" && typeof (value as any).provider === "string" && (value as any).provider.trim() && typeof (value as any).model === "string" && (value as any).model.trim() && ((value as any).thinking === undefined || (typeof (value as any).thinking === "string" && (value as any).thinking.trim())));
}

async function readAgentConfig(path: string): Promise<AgentConfig | undefined> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  let data: unknown;
  try { data = JSON.parse(source); }
  catch (error) { throw new SubagentError("INVALID_AGENT_CONFIG", `${path}: invalid JSON`, error); }
  if (!data || typeof data !== "object" || !Array.isArray((data as any).models) || !(data as any).models.length || !(data as any).models.every(isSelection)) {
    throw new SubagentError("INVALID_AGENT_CONFIG", `${path}: models must be a non-empty list of provider/model objects`);
  }
  const models = (data as any).models as ModelSelection[];
  const defaultSelection = (data as any).default;
  if (defaultSelection !== undefined && (!isSelection(defaultSelection) || !models.some((entry) => entry.provider === defaultSelection.provider && entry.model === defaultSelection.model))) {
    throw new SubagentError("INVALID_AGENT_CONFIG", `${path}: default must be included in models`);
  }
  return { models, ...(defaultSelection ? { default: defaultSelection } : {}) };
}

export async function loadAgentConfig(cwd: string): Promise<AgentConfig | undefined> {
  return await readAgentConfig(join(cwd, ".pi", "agent", "sub-agents.json"))
    ?? await readAgentConfig(join(homedir(), ".pi", "agent", "sub-agents.json"));
}

export async function discoverAgents(cwd: string): Promise<Map<string, AgentDefinition>> {
  const dir = join(cwd, ".pi", "agents");
  let files: string[];
  try { files = (await readdir(dir)).filter((x) => x.endsWith(".md")).sort(); }
  catch (error: any) { if (error.code === "ENOENT") return new Map(); throw error; }
  const output = new Map<string, AgentDefinition>();
  for (const file of files) {
    const definition = parseAgent(await readFile(join(dir, file), "utf8"), join(dir, file));
    if (output.has(definition.name)) throw new SubagentError("DUPLICATE_AGENT", `Duplicate agent name: ${definition.name}`);
    output.set(definition.name, definition);
  }
  return output;
}

export function parseAgent(source: string, path = "<agent>"): AgentDefinition {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new SubagentError("INVALID_AGENT", `${path}: expected YAML frontmatter`);
  let data: any;
  try { data = YAML.parse(match[1]!); }
  catch (error) { throw new SubagentError("INVALID_AGENT", `${path}: malformed frontmatter`, error); }
  if (!data || typeof data !== "object" || typeof data.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(data.name)) {
    throw new SubagentError("INVALID_AGENT", `${path}: valid name is required`);
  }
  const tools = typeof data.tools === "string" ? data.tools.split(",").map((x: string) => x.trim()).filter(Boolean) : data.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((x) => typeof x !== "string"))) {
    throw new SubagentError("INVALID_AGENT", `${path}: tools must be a list or comma-separated string`);
  }
  if (data.workspace !== undefined && !["current", "worktree"].includes(data.workspace)) {
    throw new SubagentError("INVALID_AGENT", `${path}: workspace must be current or worktree`);
  }
  const maxDepth = data["max-depth"] ?? data.maxDepth;
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4)) {
    throw new SubagentError("INVALID_AGENT", `${path}: max-depth must be an integer from 0 to 4`);
  }
  return {
    name: data.name,
    systemPrompt: match[2]!.trim(),
    path,
    ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(typeof data.thinking === "string" ? { thinking: data.thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(data.workspace ? { workspace: data.workspace } : {}),
    ...(typeof data.spawning === "boolean" ? { spawning: data.spawning } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
}

export async function resolveLaunch(cwd: string, task: string, agentName?: string, overrides: Partial<LaunchConfig> = {}): Promise<LaunchConfig> {
  const parentDepth = process.env.PI_TMUX_DEPTH ? Number.parseInt(process.env.PI_TMUX_DEPTH, 10) : 0;
  const parentMaxDepth = process.env.PI_TMUX_MAX_DEPTH ? Number.parseInt(process.env.PI_TMUX_MAX_DEPTH, 10) : 1;
  let base: Partial<LaunchConfig> = { depth: parentDepth, maxDepth: parentMaxDepth };
  if (agentName) {
    const found = (await discoverAgents(cwd)).get(agentName);
    if (!found) throw new SubagentError("AGENT_NOT_FOUND", `Agent definition not found: ${agentName}`);
    base = {
      ...base,
      name: found.name,
      systemPrompt: found.systemPrompt,
      maxDepth: found.spawning ? (found.maxDepth ?? parentMaxDepth) : 0,
      ...(found.provider ? { provider: found.provider } : {}),
      ...(found.model ? { model: found.model } : {}),
      ...(found.thinking ? { thinking: found.thinking } : {}),
      ...(found.tools ? { tools: found.tools } : {}),
      ...(found.workspace ? { workspace: found.workspace } : {}),
    };
  }
  const config = await loadAgentConfig(cwd);
  const launch = Object.fromEntries(Object.entries({ ...base, task, ...overrides }).filter(([, value]) => value !== undefined)) as unknown as LaunchConfig;
  if (!launch.model && !launch.provider && config?.default) {
    launch.provider = config.default.provider;
    launch.model = config.default.model;
  }
  const configuredModel = config?.models.find((entry) => entry.provider === launch.provider && entry.model === launch.model);
  if (config && (launch.model || launch.provider) && !configuredModel) {
    throw new SubagentError("MODEL_NOT_ALLOWED", `Provider/model is not allowed by sub-agents.json: ${launch.provider ?? "<missing>"}/${launch.model ?? "<missing>"}`);
  }
  if (!launch.thinking && configuredModel?.thinking) launch.thinking = configuredModel.thinking;
  return launch;
}
