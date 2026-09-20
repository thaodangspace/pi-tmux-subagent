#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Runner } from "./runner.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const runDir = argv[0];
  if (!runDir) throw new Error("Usage: runner <run-dir>");
  const rpcCommand = process.env.PI_TMUX_RPC_COMMAND;
  const rpcArgs = process.env.PI_TMUX_RPC_ARGS
    ? (JSON.parse(process.env.PI_TMUX_RPC_ARGS) as string[])
    : undefined;
  await new Runner(runDir, {
    ...(rpcCommand ? { rpcCommand } : {}),
    ...(rpcArgs ? { rpcArgs } : {}),
  }).run();
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
