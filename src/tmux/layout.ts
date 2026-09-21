import { SubagentError } from "../types.js";
import type { Executor } from "./adapter.js";

export type LayoutMode =
  "main-only" | "right-stack" | "right-grid" | "overflow";

export interface TmuxLayoutConfig {
  mainPanePercent: number;
  maxVerticalStack: number;
  maxVisibleSubagents: number;
}

export const DEFAULT_LAYOUT: Readonly<TmuxLayoutConfig> = {
  mainPanePercent: 70,
  maxVerticalStack: 4,
  maxVisibleSubagents: 8,
};

export function chooseLayout(
  agentCount: number,
  config: TmuxLayoutConfig = DEFAULT_LAYOUT,
): LayoutMode {
  if (agentCount <= 0) return "main-only";
  if (agentCount <= config.maxVerticalStack) return "right-stack";
  if (agentCount <= config.maxVisibleSubagents) return "right-grid";
  return "overflow";
}

interface PaneSet {
  width: number;
  height: number;
  agents: string[];
  hasUnmanagedPanes: boolean;
}

function distribute(total: number, count: number): number[] {
  const usable = total - count + 1;
  const base = Math.floor(usable / count);
  let remainder = usable % count;
  return Array.from({ length: count }, () => base + (remainder-- > 0 ? 1 : 0));
}

function leaf(
  width: number,
  height: number,
  x: number,
  y: number,
  id: string,
): string {
  return `${width}x${height},${x},${y},${id.replace(/^%/, "")}`;
}

function checksum(layout: string): string {
  let value = 0;
  for (const byte of Buffer.from(layout)) {
    value = ((value >> 1) | ((value & 1) << 15)) & 0xffff;
    value = (value + byte) & 0xffff;
  }
  return value.toString(16).padStart(4, "0");
}

export function buildLayout(
  width: number,
  height: number,
  mainPane: string,
  agentPanes: readonly string[],
  config: TmuxLayoutConfig = DEFAULT_LAYOUT,
): string | undefined {
  if (agentPanes.length === 0) return undefined;
  const mainWidth = Math.min(
    width - 2,
    Math.max(1, Math.round((width * config.mainPanePercent) / 100)),
  );
  const rightWidth = width - mainWidth - 1;
  const main = leaf(mainWidth, height, 0, 0, mainPane);
  let right: string;

  if (agentPanes.length <= config.maxVerticalStack) {
    const heights = distribute(height, agentPanes.length);
    let y = 0;
    const panes = agentPanes.map((id, index) => {
      const pane = leaf(rightWidth, heights[index]!, mainWidth + 1, y, id);
      y += heights[index]! + 1;
      return pane;
    });
    right = `${rightWidth}x${height},${mainWidth + 1},0[${panes.join(",")}]`;
  } else {
    const rowCount = Math.ceil(agentPanes.length / 2);
    const heights = distribute(height, rowCount);
    let y = 0;
    const rows = Array.from({ length: rowCount }, (_, row) => {
      const ids = agentPanes.slice(row * 2, row * 2 + 2);
      const widths = distribute(rightWidth, ids.length);
      let x = mainWidth + 1;
      const panes = ids.map((id, column) => {
        const pane = leaf(widths[column]!, heights[row]!, x, y, id);
        x += widths[column]! + 1;
        return pane;
      });
      const result =
        ids.length === 1
          ? panes[0]!
          : `${rightWidth}x${heights[row]},${mainWidth + 1},${y}{${panes.join(",")}}`;
      y += heights[row]! + 1;
      return result;
    });
    right = `${rightWidth}x${height},${mainWidth + 1},0[${rows.join(",")}]`;
  }

  const body = `${width}x${height},0,0{${main},${right}}`;
  return `${checksum(body)},${body}`;
}

export class TmuxLayoutManager {
  readonly config: TmuxLayoutConfig;

  constructor(
    private readonly exec: Executor,
    readonly mainPane: string | undefined = process.env.TMUX_PANE,
    config: Partial<TmuxLayoutConfig> = {},
  ) {
    this.config = { ...DEFAULT_LAYOUT, ...config };
  }

  private async panes(): Promise<PaneSet | undefined> {
    if (!this.mainPane) return undefined;
    const result = await this.exec("tmux", [
      "list-panes",
      "-t",
      this.mainPane,
      "-F",
      "#{pane_id}\t#{window_width}\t#{window_height}\t#{@pi_tmux_subagent_id}",
    ]);
    if (result.code !== 0) return undefined;
    const rows = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const first = rows[0];
    if (!first) return undefined;
    return {
      width: Number(first[1]),
      height: Number(first[2]),
      agents: rows.filter((row) => Boolean(row[3])).map((row) => row[0]!),
      // A custom tmux layout must mention every pane in the window. Avoid
      // moving or dropping panes that this extension does not own.
      hasUnmanagedPanes: rows.some(
        (row) => row[0] !== this.mainPane && !row[3],
      ),
    };
  }

  async hasVisibleCapacity(): Promise<boolean> {
    const panes = await this.panes();
    return !panes || panes.agents.length < this.config.maxVisibleSubagents;
  }

  async rebalance(): Promise<void> {
    const panes = await this.panes();
    if (!panes || !this.mainPane || panes.hasUnmanagedPanes) return;
    const layout = buildLayout(
      panes.width,
      panes.height,
      this.mainPane,
      panes.agents,
      this.config,
    );
    if (!layout) return;
    const result = await this.exec("tmux", [
      "select-layout",
      "-t",
      this.mainPane,
      layout,
    ]);
    if (result.code !== 0) {
      throw new SubagentError(
        "TMUX_LAYOUT_FAILED",
        result.stderr.trim() || "Could not apply tmux layout",
      );
    }
  }

  async focusAgentPane(paneId: string): Promise<void> {
    const result = await this.exec("tmux", ["select-pane", "-t", paneId]);
    if (result.code !== 0)
      throw new SubagentError("TMUX_FOCUS_FAILED", result.stderr.trim());
  }

  async focusMainPane(): Promise<void> {
    if (!this.mainPane) return;
    await this.focusAgentPane(this.mainPane);
  }
}
