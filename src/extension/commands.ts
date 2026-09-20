import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";
import { sessionName } from "../tmux/adapter.js";
import { workerId } from "../types.js";
import { openSubagentsControl } from "./control.js";
export function registerSubagentCommands(pi: ExtensionAPI, manager = new Manager()): void {
  pi.registerCommand("subagents", { description: "Select, inspect, or control durable subagents", handler: async (_args, ctx) => {
    await openSubagentsControl(manager, ctx);
  }});
  pi.registerCommand("subagent-attach", { description: "Show how to attach to a worker", handler: async (args, ctx) => {
    const id = workerId(args.trim()); ctx.ui.notify(`tmux attach -t ${sessionName(id)}`, "info");
  }});
}
