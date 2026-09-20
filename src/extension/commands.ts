import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";
import { workerId } from "../types.js";
import { openSubagentsControl } from "./control.js";
import { inspectWorker } from "./inspection.js";
export function registerSubagentCommands(
  pi: ExtensionAPI,
  manager = new Manager(),
): void {
  pi.registerCommand("subagents", {
    description: "Select, inspect, or control durable subagents",
    handler: async (_args, ctx) => {
      await openSubagentsControl(manager, ctx);
    },
  });
  pi.registerCommand("subagent-inspect", {
    description: "Inspect durable worker activity and result",
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(
          await inspectWorker(manager, workerId(args.trim())),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not inspect worker: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
  pi.registerCommand("subagent-attach", {
    description: "Show a safe command for attaching to a worker",
    handler: async (args, ctx) => {
      const id = workerId(args.trim());
      ctx.ui.notify(
        `Attaching inside the active Pi TUI is unsafe. Run from another terminal:\npi-tmux-subagent attach ${id}`,
        "info",
      );
    },
  });
}
