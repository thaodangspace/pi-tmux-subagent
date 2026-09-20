import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";
import { sessionName } from "../tmux/adapter.js";
import { workerId } from "../types.js";
export function registerSubagentCommands(pi: ExtensionAPI, manager = new Manager()): void {
  pi.registerCommand("subagents", { description: "List durable subagents", handler: async (_args, ctx) => {
    const workers = await manager.list(); ctx.ui.notify(workers.length ? workers.map((x) => `${x.id}  ${x.status}`).join("\n") : "No subagents", "info");
  }});
  pi.registerCommand("subagent-attach", { description: "Show how to attach to a worker", handler: async (args, ctx) => {
    const id = workerId(args.trim()); ctx.ui.notify(`tmux attach -t ${sessionName(id)}`, "info");
  }});
}
