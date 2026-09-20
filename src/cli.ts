#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Manager } from "./manager/manager.js";
import { ProtocolStore } from "./protocol/store.js";

export const HELP = `pi-tmux-subagent — durable Pi RPC workers supervised by tmux

Usage:
  pi-tmux-subagent <command> [options]

Commands:
  spawn <task>       Start a worker
  send <id> <text>   Send a follow-up prompt
  steer <id> <text>  Steer the active turn
  status <id>        Show durable worker state
  result <id>        Show the latest final result
  stop <id>          Stop a worker
  list               List durable workers
  attach <id>        Attach to the worker tmux session
  help               Show this help
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const manager = new Manager({ ...(process.env.PI_TMUX_REGISTRY ? { store: new ProtocolStore(process.env.PI_TMUX_REGISTRY) } : {}) });
  const id = argv[1];
  try {
    let value: unknown;
    if (command === "spawn") {
      const task = argv.slice(1).join(" "); if (!task) throw new Error("spawn requires a task");
      value = await manager.spawn({ task });
    } else if (command === "send" || command === "steer") {
      if (!id || argv.length < 3) throw new Error(`${command} requires <id> <text>`);
      value = { id, seq: await manager[command](id, argv.slice(2).join(" ")) };
    } else if (command === "stop") {
      if (!id) throw new Error("stop requires <id>"); value = { id, seq: await manager.stop(id) };
    } else if (command === "status") {
      if (!id) throw new Error("status requires <id>"); value = await manager.status(id);
    } else if (command === "result") {
      if (!id) throw new Error("result requires <id>"); value = await manager.result(id) ?? { id, result: null };
    } else if (command === "list") value = await manager.list();
    else if (command === "attach") { if (!id) throw new Error("attach requires <id>"); await manager.attach(id); return 0; }
    else { process.stderr.write(`Unknown command: ${command}\n`); return 2; }
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1;
  }
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
