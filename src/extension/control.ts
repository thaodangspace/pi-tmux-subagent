import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Manager } from "../manager/manager.js";
import { inspectWorker } from "./inspection.js";
import { loadWorkerViews } from "./widget.js";

export async function openSubagentsControl(
  manager: Manager,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    const workers = await loadWorkerViews(manager, Date.now(), ctx.cwd);
    ctx.ui.notify(
      workers.length
        ? workers
            .map(
              (worker) =>
                `${worker.id}  ${worker.status}${worker.modelLabel ? `  ${worker.modelLabel}` : ""}`,
            )
            .join("\n")
        : "No subagents",
      "info",
    );
    return;
  }
  try {
    const views = await loadWorkerViews(manager, Date.now(), ctx.cwd);
    if (!views.length) {
      ctx.ui.notify("No subagents", "info");
      return;
    }
    const labels = views.map(
      (view) =>
        `${view.name ?? view.id}  ${view.status}  turn ${view.turn}${view.modelLabel ? `  ${view.modelLabel}` : ""}`,
    );
    const selectedLabel = await ctx.ui.select("Select a subagent", labels);
    if (!selectedLabel) return;
    const selected = views[labels.indexOf(selectedLabel)];
    if (!selected) {
      ctx.ui.notify(
        "Worker is no longer available; refresh and try again",
        "warning",
      );
      return;
    }
    const state = await manager.status(selected.id);
    const [meta, result] = await Promise.all([
      manager.store.readMeta(selected.id),
      manager.result(selected.id),
    ]);
    const detail = [
      `${meta.launch.name ?? selected.id} (${selected.id})`,
      `status: ${state.status} · turn ${state.turn}`,
      selected.modelLabel ? `model: ${selected.modelLabel}` : undefined,
      `cwd: ${meta.cwd}`,
      selected.latestActivity
        ? `activity: ${selected.latestActivity}`
        : undefined,
      result?.text ? `result: ${bounded(result.text)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const terminal =
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "stopped" ||
      state.status === "orphaned";
    const actions = terminal
      ? ["Inspect / attach", "Delete", "Close"]
      : ["Send follow-up", "Steer", "Stop", "Inspect / attach", "Close"];
    const action = await ctx.ui.select(detail, actions);
    if (action === "Send follow-up" || action === "Steer") {
      const message = await ctx.ui.input(action, "Instruction for the worker");
      if (!message) return;
      if (action === "Send follow-up") await manager.send(selected.id, message);
      else await manager.steer(selected.id, message);
      ctx.ui.notify(`${action} queued for ${selected.id}`, "info");
    } else if (action === "Stop") {
      if (
        await ctx.ui.confirm(
          "Stop subagent?",
          `Queue a graceful stop for ${selected.id}?`,
        )
      ) {
        await manager.stop(selected.id);
        ctx.ui.notify(`Stop queued for ${selected.id}`, "warning");
      }
    } else if (action === "Inspect / attach") {
      ctx.ui.notify(await inspectWorker(manager, selected.id), "info");
    } else if (action === "Delete") {
      if (
        await ctx.ui.confirm(
          "Delete subagent?",
          `Permanently delete all stored data for ${selected.id}?`,
        )
      ) {
        await manager.delete(selected.id);
        ctx.ui.notify(`Deleted ${selected.id}`, "warning");
      }
    }
  } catch (error) {
    ctx.ui.notify(
      `Subagent action failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
function bounded(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
