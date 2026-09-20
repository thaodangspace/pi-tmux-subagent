import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";
import { registerSubagentCommands } from "./commands.js";
import { registerSubagentTool } from "./tool.js";
import { ActivityWatcher } from "./watcher.js";
export default function extension(pi: ExtensionAPI): void {
  const manager = new Manager();
  let watcher: ActivityWatcher | undefined;
  registerSubagentTool(pi, manager);
  registerSubagentCommands(pi, manager);
  pi.on("session_start", async (_event, ctx) => {
    watcher?.dispose();
    watcher = undefined;
    if (!ctx.hasUI) return;
    watcher = new ActivityWatcher(manager, ctx);
    await watcher.start();
  });
  pi.on("session_shutdown", () => { watcher?.dispose(); watcher = undefined; });
}
