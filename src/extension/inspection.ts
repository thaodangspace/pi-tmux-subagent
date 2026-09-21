import type { Manager } from "../manager/manager.js";
import type { WorkerCommand, WorkerEvent } from "../protocol/types.js";
import { projectWorker, recentActivity } from "./projection.js";

export async function inspectWorker(
  manager: Manager,
  id: string,
  activityLimit = 8,
): Promise<string> {
  const state = await manager.status(id);
  const [meta, events, commands, result] = await Promise.all([
    manager.store.readMeta(id),
    manager.store.readLog<WorkerEvent>(id, "events"),
    manager.store.readLog<WorkerCommand>(id, "commands"),
    manager.result(id),
  ]);
  const input = {
    state,
    meta,
    events,
    commands,
    ...(result ? { result } : {}),
  };
  const view = projectWorker(input);
  const lines = [
    `worker: ${meta.launch.name ?? id}`,
    meta.launch.agent ? `agent: ${meta.launch.agent}` : undefined,
    view.modelLabel ? `model: ${view.modelLabel}` : undefined,
    `status: ${state.status} · turn ${state.turn}`,
    `id: ${id}`,
    `cwd: ${meta.cwd}`,
    meta.workspace?.branch ? `branch: ${meta.workspace.branch}` : undefined,
    meta.workspace?.worktree
      ? `worktree: ${meta.workspace.worktree}`
      : undefined,
    meta.workspace?.changedFiles?.length
      ? `changed: ${meta.workspace.changedFiles.join(", ")}`
      : undefined,
    view.latestActivity ? `latest: ${view.latestActivity}` : undefined,
    "",
    "Recent activity:",
    ...recentActivity(input, activityLimit).map(
      (item) => `${item.at} [${item.kind}] ${item.text}`,
    ),
  ];
  if (result)
    lines.push(
      "",
      `Latest result (${result.completedAt}):`,
      bounded(result.text, 2_000),
    );
  lines.push("", `Attach from another terminal: pi-tmux-subagent attach ${id}`);
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function bounded(text: string, limit: number): string {
  const value = text.trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
