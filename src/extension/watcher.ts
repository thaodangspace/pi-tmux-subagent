import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Manager } from "../manager/manager.js";
import type { WorkerActivityView } from "./projection.js";
import { loadWorkerViews, setSubagentsWidget } from "./widget.js";

export interface ActivityWatcherOptions { intervalMs?: number; onError?: (error: unknown) => void }
export class ActivityWatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private refreshing: Promise<void> | undefined;
  private fingerprint: string | undefined;
  constructor(private readonly manager: Manager, private readonly ctx: ExtensionContext, private readonly options: ActivityWatcherOptions = {}) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refresh();
    this.schedule();
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().finally(() => this.schedule());
    }, this.options.intervalMs ?? 750);
    this.timer.unref?.();
  }
  private async performRefresh(): Promise<void> {
    try {
      const allViews = await loadWorkerViews(this.manager, Date.now(), this.ctx.cwd);
      const views = allViews.filter((view) => view.status === "running" || view.status === "waiting" || view.status === "failed");
      const next = meaningfulFingerprint(views);
      if (next !== this.fingerprint) {
        this.fingerprint = next;
        setSubagentsWidget(this.ctx, views);
      }
    } catch (error) { this.options.onError?.(error); }
  }
}

function meaningfulFingerprint(views: WorkerActivityView[]): string {
  return JSON.stringify(views.map((view) => ({
    id: view.id, name: view.name, status: view.status, turn: view.turn,
    modelLabel: view.modelLabel, startedAt: view.startedAt, updatedAt: view.updatedAt,
    latestActivity: view.latestActivity, latestActivityKind: view.latestActivityKind,
  })));
}
