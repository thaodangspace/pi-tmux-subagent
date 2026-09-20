#!/usr/bin/env node
import { pathToFileURL } from "node:url";

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
  process.stderr.write(`Command not implemented: ${command}\n`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
