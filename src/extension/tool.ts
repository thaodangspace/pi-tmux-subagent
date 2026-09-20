import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";

const subagentSchema = Type.Object({
  action: StringEnum(["spawn", "send", "steer", "status", "result", "stop", "list"] as const),
  id: Type.Optional(Type.String()), task: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()), agent: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()), workspace: Type.Optional(StringEnum(["current", "worktree"] as const)),
});
export interface SubagentInput { action: "spawn" | "send" | "steer" | "status" | "result" | "stop" | "list"; id?: string; task?: string; message?: string; name?: string; agent?: string; model?: string; thinking?: string; workspace?: "current" | "worktree" }
function requireValue(value: string | undefined, name: string): string { if (!value) throw new Error(`${name} is required`); return value; }
export function registerSubagentTool(pi: ExtensionAPI, manager = new Manager()): void {
  pi.registerTool({
    name: "subagent", label: "Subagent", description: "Spawn and control durable Pi workers. Output is truncated to concise JSON.",
    promptSnippet: "Spawn or control durable background Pi workers", parameters: subagentSchema,
    async execute(_id, input, signal, onUpdate, ctx) {
      signal?.throwIfAborted(); onUpdate?.({ content: [{ type: "text", text: `${input.action}…` }], details: {} });
      let value: unknown;
      if (input.action === "spawn") value = await manager.spawn({ task: requireValue(input.task, "task"), ...(input.name ? { name: input.name } : {}), ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}), ...(input.workspace ? { workspace: input.workspace } : {}) }, ctx.cwd);
      else if (input.action === "send") value = { id: input.id, seq: await manager.send(requireValue(input.id, "id"), requireValue(input.message, "message")) };
      else if (input.action === "steer") value = { id: input.id, seq: await manager.steer(requireValue(input.id, "id"), requireValue(input.message, "message")) };
      else if (input.action === "status") value = await manager.recover(requireValue(input.id, "id"));
      else if (input.action === "result") value = await manager.result(requireValue(input.id, "id")) ?? { id: input.id, result: null };
      else if (input.action === "stop") value = { id: input.id, seq: await manager.stop(requireValue(input.id, "id")) };
      else value = await manager.list();
      const text = JSON.stringify(value); return { content: [{ type: "text", text: text.length > 50_000 ? `${text.slice(0, 50_000)}…` : text }], details: value };
    },
  });
}
