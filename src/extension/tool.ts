import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";
import { resolveLaunch } from "../agents/discover.js";

const subagentSchema = Type.Object({
  action: StringEnum([
    "spawn",
    "send",
    "steer",
    "status",
    "result",
    "events",
    "stop",
    "kill",
    "delete",
    "list",
  ] as const),
  id: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  workspace: Type.Optional(StringEnum(["current", "worktree"] as const)),
  mode: Type.Optional(StringEnum(["full"] as const)),
  turn: Type.Optional(Type.Integer({ minimum: 0 })),
  resultSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  fromSeq: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
export interface SubagentInput {
  action:
    | "spawn"
    | "send"
    | "steer"
    | "status"
    | "result"
    | "events"
    | "stop"
    | "kill"
    | "delete"
    | "list";
  id?: string;
  task?: string;
  message?: string;
  name?: string;
  agent?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  workspace?: "current" | "worktree";
  mode?: "full";
  turn?: number;
  resultSeq?: number;
  fromSeq?: number;
  limit?: number;
}
function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export function registerSubagentTool(
  pi: ExtensionAPI,
  manager = new Manager(),
): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn and control durable background Pi workers. Output is truncated to concise JSON. Automatic completion notifications deliver compact summaries; use action 'result' as an explicit opt-in to fetch complete answers and workspace metadata, or action 'events' for bounded event history inspection.",
    promptSnippet:
      "Spawn or control background workers, or opt-in to fetch full results/events after completion",
    parameters: subagentSchema,
    async execute(_id, input, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      onUpdate?.({
        content: [{ type: "text", text: `${input.action}…` }],
        details: {},
      });
      let value: unknown;
      if (input.action === "spawn")
        value = await manager.spawn(
          await resolveLaunch(
            ctx.cwd,
            requireValue(input.task, "task"),
            input.agent,
            {
              ...(input.name ? { name: input.name } : {}),
              ...(input.provider ? { provider: input.provider } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.thinking ? { thinking: input.thinking } : {}),
              ...(input.workspace ? { workspace: input.workspace } : {}),
            },
          ),
          ctx.cwd,
          undefined,
          ctx.sessionManager.getSessionId(),
        );
      else if (input.action === "send")
        value = {
          id: input.id,
          seq: await manager.send(
            requireValue(input.id, "id"),
            requireValue(input.message, "message"),
          ),
        };
      else if (input.action === "steer")
        value = {
          id: input.id,
          seq: await manager.steer(
            requireValue(input.id, "id"),
            requireValue(input.message, "message"),
          ),
        };
      else if (input.action === "status")
        value = await manager.recover(requireValue(input.id, "id"));
      else if (input.action === "result") {
        if ((input.turn === undefined) !== (input.resultSeq === undefined)) {
          throw new Error("result requires both turn and resultSeq when either is supplied");
        }
        value = await manager.getResult(
          requireValue(input.id, "id"),
          input.turn !== undefined && input.resultSeq !== undefined
            ? { turn: input.turn, resultSeq: input.resultSeq }
            : undefined,
        );
      }
      else if (input.action === "events")
        value = await manager.events(requireValue(input.id, "id"), {
          ...(input.fromSeq !== undefined ? { fromSeq: input.fromSeq } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      else if (input.action === "stop")
        value = {
          id: input.id,
          seq: await manager.stop(requireValue(input.id, "id")),
        };
      else if (input.action === "kill")
        value = await manager.forceTerminate(requireValue(input.id, "id"));
      else if (input.action === "delete") {
        const id = requireValue(input.id, "id");
        await manager.delete(id);
        value = { id, deleted: true };
      } else value = await manager.list();
      const text = JSON.stringify(value);
      return {
        content: [
          {
            type: "text",
            text: text.length > 50_000 ? `${text.slice(0, 50_000)}…` : text,
          },
        ],
        details: value,
      };
    },
  });
}
