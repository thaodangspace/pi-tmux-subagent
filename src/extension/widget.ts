import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Manager } from "../manager/manager.js";
import type { WorkerCommand, WorkerEvent } from "../protocol/types.js";
import { projectWorker, type WorkerActivityView } from "./projection.js";

export const SUBAGENTS_WIDGET_ID = "tmux-subagents";

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}
function elapsed(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "--:--";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
const indicator: Record<string, string> = { starting: "◌", running: "●", waiting: "○", completed: "✓", failed: "✗", stopped: "■", orphaned: "!" };

export function renderSubagentsWidget(workers: WorkerActivityView[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  const title = workers.length ? `Subagents  ${workers.length} agent${workers.length === 1 ? "" : "s"}` : "Subagents  no agents";
  if (!workers.length) return [truncate(title, safeWidth)];
  const lines = [truncate(title, safeWidth)];
  for (const worker of workers) {
    const name = worker.name || worker.id;
    const full = `${indicator[worker.status] ?? "○"} ${name}  ${worker.status}  turn ${worker.turn}  ${elapsed(worker.elapsedMs)}`;
    const compact = `${indicator[worker.status] ?? "○"} ${name}  ${worker.status}`;
    lines.push(truncate(safeWidth >= 42 ? full : compact, safeWidth));
    if (worker.latestActivity && safeWidth >= 24) lines.push(truncate(`  ${worker.latestActivity}`, safeWidth));
  }
  return lines;
}

export async function loadWorkerViews(manager: Manager, now = Date.now()): Promise<WorkerActivityView[]> {
  const states = await manager.list();
  return await Promise.all(states.map(async (state) => {
    const id = state.id;
    const [meta, events, commands, result] = await Promise.all([
      manager.store.readMeta(id).catch(() => undefined),
      manager.store.readLog<WorkerEvent>(id, "events").catch(() => []),
      manager.store.readLog<WorkerCommand>(id, "commands").catch(() => []),
      manager.store.readResult(id).catch(() => undefined),
    ]);
    return projectWorker({ state, ...(meta ? { meta } : {}), events, commands, ...(result ? { result } : {}) }, now);
  }));
}

export function setSubagentsWidget(ctx: ExtensionContext, workers: WorkerActivityView[]): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(SUBAGENTS_WIDGET_ID, () => ({
    render: (width: number) => renderSubagentsWidget(workers, width),
    invalidate() {},
  }), { placement: "belowEditor" });
}
