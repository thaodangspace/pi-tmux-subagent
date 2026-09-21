import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { Manager } from "../manager/manager.js";
import type { WorkerCommand, WorkerEvent } from "../protocol/types.js";
import {
  formatWorkerIdentity,
  projectWorker,
  type WorkerActivityView,
} from "./projection.js";
import { elapsed, pad, truncate } from "../runner/format.js";

export const SUBAGENTS_WIDGET_ID = "tmux-subagents";

function detail(worker: WorkerActivityView): string {
  if (worker.latestActivityKind === "tool" && worker.latestActivity) {
    return worker.latestActivity.replace(/^\[tool\]\s*/, "");
  }
  return `turn ${worker.turn}`;
}

export function renderSubagentsWidget(
  workers: WorkerActivityView[],
  width: number,
): string[] {
  const boxWidth = Math.min(62, Math.max(1, width));
  if (boxWidth < 4) return ["─".repeat(boxWidth)];

  const inside = boxWidth - 2;
  const topLabel = "─ subagents ";
  const top = `┌${truncate(topLabel, inside).padEnd(inside, "─")}┐`;
  const bottom = `└${"─".repeat(inside)}┘`;
  if (!workers.length) return [top, `│${pad("  no agents", inside)}│`, bottom];

  const nameWidth = Math.min(
    24,
    Math.max(
      8,
      ...workers.map((worker) => formatWorkerIdentity(worker).length),
    ),
  );
  const statusWidth = Math.min(
    10,
    Math.max(7, ...workers.map((worker) => worker.status.length)),
  );
  const timeWidth = workers.some(
    (worker) => elapsed(worker.elapsedMs).length > 5,
  )
    ? 8
    : 5;
  const fixedWidth = 2 + nameWidth + 2 + statusWidth + 2 + 2 + timeWidth + 2;
  const detailWidth = inside - fixedWidth;

  const rows = workers.map((worker) => {
    const name = formatWorkerIdentity(worker);
    const compact = `  ${name}  ${worker.status}`;
    if (detailWidth < 5) return `│${pad(compact, inside)}│`;
    const content = `  ${pad(name, nameWidth)}  ${pad(worker.status, statusWidth)}  ${pad(detail(worker), detailWidth)}  ${elapsed(worker.elapsedMs)}  `;
    return `│${pad(content, inside)}│`;
  });
  return [top, ...rows, bottom];
}

export async function loadWorkerViews(
  manager: Manager,
  now = Date.now(),
  workspaceRoot?: string,
): Promise<WorkerActivityView[]> {
  const states = await manager.list();
  const views = await Promise.all(
    states.map(async (state) => {
      const id = state.id;
      const meta = await manager.store.readMeta(id).catch(() => undefined);
      if (
        workspaceRoot &&
        (!meta ||
          resolve(meta.workspace?.root ?? meta.cwd) !== resolve(workspaceRoot))
      )
        return undefined;
      const [events, commands, result] = await Promise.all([
        manager.store
          .readLogTail<WorkerEvent>(id, "events", 20)
          .catch(() => []),
        manager.store
          .readLogTail<WorkerCommand>(id, "commands", 20)
          .catch(() => []),
        manager.store.readResult(id).catch(() => undefined),
      ]);
      return projectWorker(
        {
          state,
          ...(meta ? { meta } : {}),
          events,
          commands,
          ...(result ? { result } : {}),
        },
        now,
      );
    }),
  );
  return views.filter((view): view is WorkerActivityView => view !== undefined);
}

export function setSubagentsWidget(
  ctx: ExtensionContext,
  workers: WorkerActivityView[],
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    SUBAGENTS_WIDGET_ID,
    () => ({
      render: (width: number) => renderSubagentsWidget(workers, width),
      invalidate() {},
    }),
    { placement: "belowEditor" },
  );
}
