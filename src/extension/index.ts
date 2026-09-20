import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Manager } from "../manager/manager.js";
import { registerSubagentCommands } from "./commands.js";
import { registerSubagentTool } from "./tool.js";
export default function extension(pi: ExtensionAPI): void { const manager = new Manager(); registerSubagentTool(pi, manager); registerSubagentCommands(pi, manager); }
