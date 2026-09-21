import type { WorkerStatus } from "../protocol/types.js";
import {
  elapsed,
  formatStatus,
  modelSelectionLabel,
  pad,
  truncate,
  wrapText,
} from "./format.js";
import type { PresentationEvent } from "./renderer.js";

export interface ActivityBlock {
  id: string;
  kind: "tool" | "text" | "error" | "state";
  lines: string[];
}

export interface SubagentMonitorOptions {
  id: string;
  name?: string | undefined;
  agent?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  status?: WorkerStatus | string | undefined;
  turn?: number | undefined;
  startedAt?: string | undefined;
  output?: NodeJS.WritableStream | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
  isTty?: boolean | undefined;
  throttleMs?: number | undefined;
}

export class SubagentMonitor {
  readonly id: string;
  name: string | undefined;
  agent: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
  status: WorkerStatus | string;
  turn: number;
  startedAt: string | undefined;

  private readonly output: NodeJS.WritableStream;
  private readonly isTty: boolean;
  private readonly throttleMs: number;
  private columns: number | undefined;
  private rows: number | undefined;

  private activities: ActivityBlock[] = [];
  private currentStreamingText = "";
  private currentStreamingBlockId: string | undefined;
  private throttleTimer: NodeJS.Timeout | undefined;
  private activityCounter = 0;
  private started = false;

  constructor(options: SubagentMonitorOptions) {
    this.id = options.id;
    this.name = options.name;
    this.agent = options.agent;
    this.provider = options.provider;
    this.model = options.model;
    this.thinking = options.thinking;
    this.status = options.status ?? "starting";
    this.turn = options.turn ?? 0;
    this.startedAt = options.startedAt;

    this.output = options.output ?? process.stdout;
    this.columns = options.columns;
    this.rows = options.rows;
    this.throttleMs = options.throttleMs ?? 50;

    this.isTty =
      options.isTty ??
      Boolean(
        (this.output as any)?.isTTY ??
        (this.output === process.stdout && process.stdout.isTTY),
      );
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.isTty) {
      this.output.write("\x1b[?25l"); // hide cursor
      const term = this.output as any;
      if (typeof term?.on === "function") {
        term.on("resize", this.handleResize);
      }
    }
    this.flush();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }

    const term = this.output as any;
    if (typeof term?.removeListener === "function") {
      term.removeListener("resize", this.handleResize);
    }

    this.flush();
    if (this.isTty) {
      this.output.write("\x1b[?25h"); // restore cursor
    }
  }

  private handleResize = (): void => {
    if (this.isTty) {
      this.output.write("\x1b[2J\x1b[H");
    }
    this.flush();
  };

  updateMeta(meta: {
    name?: string | undefined;
    agent?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    thinking?: string | undefined;
    activeModel?:
      | {
          provider?: string | undefined;
          model?: string | undefined;
          thinking?: string | undefined;
        }
      | undefined;
  }): void {
    if (meta.name !== undefined) this.name = meta.name;
    if (meta.agent !== undefined) this.agent = meta.agent;

    const active = meta.activeModel;
    if (active) {
      if (active.provider !== undefined) this.provider = active.provider;
      if (active.model !== undefined) this.model = active.model;
      if (active.thinking !== undefined) this.thinking = active.thinking;
    } else {
      if (meta.provider !== undefined) this.provider = meta.provider;
      if (meta.model !== undefined) this.model = meta.model;
      if (meta.thinking !== undefined) this.thinking = meta.thinking;
    }
    this.requestRender();
  }

  updateStatus(status: WorkerStatus | string, turn?: number): void {
    this.status = status;
    if (turn !== undefined) this.turn = turn;
    this.requestRender();
  }

  handleEvent(event: PresentationEvent): void {
    switch (event.kind) {
      case "agent_start":
        this.status = "running";
        this.finalizeStreamingText();
        this.requestRender();
        break;

      case "agent_settled":
        this.status = "waiting";
        this.finalizeStreamingText();
        this.requestRender();
        break;

      case "tool_start": {
        this.finalizeStreamingText();
        const lines: string[] = [`TOOL ${event.toolName}`];
        if (event.detail) lines.push(event.detail);
        this.addActivity({
          id: `act-${++this.activityCounter}`,
          kind: "tool",
          lines,
        });
        this.requestRender();
        break;
      }

      case "tool_end":
        // Tool execution ended; state transition already captured
        break;

      case "text_delta":
        this.appendStreamingText(event.delta);
        break;

      case "message_end":
        if (event.text && !this.currentStreamingText) {
          this.addActivity({
            id: `act-${++this.activityCounter}`,
            kind: "text",
            lines: [event.text],
          });
        }
        this.finalizeStreamingText();
        this.requestRender();
        break;

      case "error":
        this.finalizeStreamingText();
        this.addActivity({
          id: `act-${++this.activityCounter}`,
          kind: "error",
          lines: [`ERROR ${event.message}`],
        });
        this.requestRender();
        break;

      case "unresponsive":
        this.status = "unresponsive";
        this.finalizeStreamingText();
        this.addActivity({
          id: `act-${++this.activityCounter}`,
          kind: "state",
          lines: [
            event.message
              ? `UNRESPONSIVE ${event.message}`
              : "worker unresponsive",
          ],
        });
        this.requestRender();
        break;

      case "responsive":
        this.status = "running";
        this.addActivity({
          id: `act-${++this.activityCounter}`,
          kind: "state",
          lines: ["worker resumed responding"],
        });
        this.requestRender();
        break;
    }
  }

  tick(): void {
    // Called periodically by runner heartbeat to refresh elapsed time
    this.requestRender();
  }

  private appendStreamingText(delta: string): void {
    this.currentStreamingText += delta;
    if (!this.currentStreamingBlockId) {
      this.currentStreamingBlockId = `act-${++this.activityCounter}`;
      this.addActivity({
        id: this.currentStreamingBlockId,
        kind: "text",
        lines: [this.currentStreamingText],
      });
    } else {
      const block = this.activities.find(
        (a) => a.id === this.currentStreamingBlockId,
      );
      if (block) {
        block.lines = [this.currentStreamingText];
      }
    }
    this.scheduleThrottledRender();
  }

  private finalizeStreamingText(): void {
    this.currentStreamingText = "";
    this.currentStreamingBlockId = undefined;
  }

  private addActivity(block: ActivityBlock): void {
    this.activities.push(block);
    if (this.activities.length > 50) {
      this.activities.shift();
    }
  }

  private scheduleThrottledRender(): void {
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      this.flush();
    }, this.throttleMs);
  }

  private requestRender(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    this.flush();
  }

  flush(now = Date.now()): void {
    if (!this.started) return;
    const cols =
      this.columns ??
      (this.output as any)?.columns ??
      (this.output === process.stdout ? process.stdout.columns : undefined) ??
      80;
    const terminalRows =
      this.rows ??
      (this.output as any)?.rows ??
      (this.output === process.stdout ? process.stdout.rows : undefined) ??
      24;

    const rows = this.isTty
      ? terminalRows
      : Math.min(terminalRows, this.calculateCompactHeight(cols));

    const lines = this.render(cols, rows, now);

    if (this.isTty) {
      // Overwrite in place from top-left, erasing remainder of each line
      const frame = lines.map((l) => `${l}\x1b[K`).join("\n") + "\x1b[J";
      this.output.write(`\x1b[H${frame}`);
    } else {
      this.output.write(`${lines.join("\n")}\n`);
    }
  }

  private calculateCompactHeight(width: number): number {
    const actLines = this.collectActivityLines(Math.max(10, width - 4));
    // Top border (1) + up to 5 header rows + divider (1) + bottom border (1)
    const headerRowsCount =
      1 + (this.agent && this.agent !== this.name ? 1 : 0) + 3 + 1 + 1;
    return Math.max(6, headerRowsCount + Math.min(actLines.length, 12));
  }

  /**
   * Pure, width- and height-sensitive monitor renderer.
   * Returns an array of exactly `height` strings, each fitting within `width`.
   */
  render(width = 80, height = 24, now = Date.now()): string[] {
    const safeWidth = Math.max(10, width);
    const safeHeight = Math.max(1, height);

    const isVerySmall = safeHeight < 6 || safeWidth < 25;
    const isNarrow = !isVerySmall && (safeHeight < 10 || safeWidth < 40);

    if (isVerySmall) {
      return this.renderVerySmall(safeWidth, safeHeight, now);
    }
    if (isNarrow) {
      return this.renderNarrow(safeWidth, safeHeight, now);
    }
    return this.renderWide(safeWidth, safeHeight, now);
  }

  private getModelLabel(): string | undefined {
    return modelSelectionLabel({
      provider: this.provider,
      model: this.model,
      thinking: this.thinking,
    });
  }

  private getElapsedText(now: number): string {
    const elapsedMs = this.startedAt
      ? Math.max(0, now - Date.parse(this.startedAt))
      : undefined;
    return elapsed(elapsedMs);
  }

  private renderVerySmall(
    width: number,
    height: number,
    now: number,
  ): string[] {
    const title = this.name ?? this.agent ?? this.id;
    const statusInfo = formatStatus(this.status);
    const model = this.getModelLabel();
    const timeStr = this.getElapsedText(now);

    const lines: string[] = [];

    if (height === 1) {
      return [truncate(`${title} ${statusInfo.text} ${timeStr}`, width)];
    }

    lines.push(truncate(`${title}: ${statusInfo.text}`, width));

    const line2Parts = [
      model ? truncate(model, Math.max(8, width - 15)) : undefined,
      this.turn > 0
        ? width >= 18
          ? `turn ${this.turn}`
          : `t${this.turn}`
        : undefined,
      timeStr,
    ].filter(Boolean);
    lines.push(truncate(line2Parts.join(" · "), width));

    if (lines.length >= height) {
      return lines.slice(0, height);
    }

    // Remaining rows for activity
    const activityLines = this.collectActivityLines(width);
    const needed = height - lines.length;
    const selected = activityLines.slice(-needed);

    for (const actLine of selected) {
      lines.push(truncate(actLine, width));
    }

    while (lines.length < height) {
      lines.push("");
    }

    return lines;
  }

  private renderNarrow(width: number, height: number, now: number): string[] {
    const title = this.name ?? this.agent ?? this.id;
    const statusInfo = formatStatus(this.status);
    const timeStr = this.getElapsedText(now);
    const contentWidth = width - 4;

    const topBorder = makeTopBorder(title, width);
    const bottomBorder = `└${"─".repeat(width - 2)}┘`;
    const divider = `├${"─".repeat(width - 2)}┤`;

    const statusParts = [
      statusInfo.text,
      this.turn > 0 ? `t${this.turn}` : undefined,
      timeStr,
    ].filter(Boolean);
    const statusRow = `│ ${pad(statusParts.join(" · "), contentWidth)} │`;

    // Fixed rows: top, status, divider, bottom = 4 rows
    const activityCapacity = Math.max(0, height - 4);
    const activityLines = this.collectActivityLines(contentWidth);
    const visibleActivity = activityLines.slice(-activityCapacity);

    const rows: string[] = [topBorder, statusRow, divider];

    for (let i = 0; i < activityCapacity; i++) {
      const text = visibleActivity[i] ?? "";
      rows.push(`│ ${pad(text, contentWidth)} │`);
    }

    rows.push(bottomBorder);
    return rows;
  }

  private renderWide(width: number, height: number, now: number): string[] {
    const title = this.name ?? this.agent ?? this.id;
    const contentWidth = width - 4;
    const statusInfo = formatStatus(this.status);
    const timeStr = this.getElapsedText(now);
    const model = this.getModelLabel();

    const topBorder = makeTopBorder(title, width);
    const bottomBorder = `└${"─".repeat(width - 2)}┘`;
    const divider = `├${"─".repeat(width - 2)}┤`;

    const headerRows: string[] = [];

    if (this.agent && this.agent !== this.name) {
      headerRows.push(`agent   ${this.agent}`);
    }

    headerRows.push(`model   ${model ?? "--"}`);

    const turnPart = this.turn > 0 ? `turn ${this.turn}` : "";
    const statusLine = turnPart
      ? `status  ${statusInfo.text.padEnd(14)}${turnPart}`
      : `status  ${statusInfo.text}`;
    headerRows.push(statusLine);
    headerRows.push(`time    ${timeStr}`);

    const fixedRowCount = 1 + headerRows.length + 1 + 1; // top + header + divider + bottom
    const activityCapacity = Math.max(0, height - fixedRowCount);

    const activityLines = this.collectActivityLines(contentWidth);
    const visibleActivity = activityLines.slice(-activityCapacity);

    const rows: string[] = [topBorder];
    for (const h of headerRows) {
      rows.push(`│ ${pad(h, contentWidth)} │`);
    }
    rows.push(divider);

    for (let i = 0; i < activityCapacity; i++) {
      const text = visibleActivity[i] ?? "";
      rows.push(`│ ${pad(text, contentWidth)} │`);
    }

    rows.push(bottomBorder);
    return rows;
  }

  private collectActivityLines(maxWidth: number): string[] {
    const lines: string[] = [];

    for (let i = 0; i < this.activities.length; i++) {
      const block = this.activities[i]!;
      if (i > 0 && lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }

      for (const line of block.lines) {
        if (block.kind === "text") {
          const wrapped = wrapText(line, maxWidth);
          lines.push(...wrapped);
        } else {
          lines.push(truncate(line, maxWidth));
        }
      }
    }

    return lines;
  }
}

function makeTopBorder(title: string, width: number): string {
  const maxTitle = Math.max(0, width - 6);
  const t = truncate(title, maxTitle);
  const titleChunk = t ? ` ${t} ` : "─";
  const remain = Math.max(0, width - 2 - titleChunk.length);
  return `┌${titleChunk}${"─".repeat(remain)}┐`;
}
