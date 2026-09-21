import type { WorkerId } from "../types.js";

export const PROTOCOL_VERSION = 1 as const;
export type WorkerStatus =
  | "starting"
  | "running"
  | "waiting"
  /** @deprecated Legacy terminal worker snapshot; new runners never emit it. */
  | "completed"
  | "failed"
  | "stopped"
  | "killed"
  | "orphaned"
  | "unresponsive";
export type WorkspaceMode = "current" | "worktree";
export interface WorkspaceMetadata {
  mode: WorkspaceMode;
  root: string;
  branch?: string;
  worktree?: string;
  commit?: string;
  changedFiles?: string[];
}
export interface ActiveModelSelection {
  provider?: string;
  model?: string;
  thinking?: string;
}
export interface LaunchConfig {
  task: string;
  agent?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt?: string;
  workspace?: WorkspaceMode;
  depth?: number;
  maxDepth?: number;
  rpcArgs?: string[];
}
export interface WorkerMeta {
  version: 1;
  id: WorkerId;
  /** Unique durable incarnation identity across re-creations. */
  instanceId?: string;
  /** Stable Pi parent session identity. Omitted for CLI/manual workers. */
  ownerSessionKey?: string;
  tmuxSession: string;
  /** Stable tmux pane identity; indexes and positions may change on rebalance. */
  tmuxPane?: string;
  createdAt: string;
  cwd: string;
  launch: LaunchConfig;
  runnerPid?: number;
  piPid?: number;
  heartbeatAt?: string;
  workspace?: WorkspaceMetadata;
  piSessionId?: string;
  piSessionFile?: string;
  activeModel?: ActiveModelSelection;
}
export type WorkerCommand =
  | {
      version: 1;
      seq: number;
      at: string;
      type: "prompt" | "send" | "steer";
      text: string;
    }
  | { version: 1; seq: number; at: string; type: "abort" | "stop" };
export interface WorkerEvent {
  version: 1;
  seq: number;
  at: string;
  type: string;
  commandSeq?: number;
  data?: unknown;
}
export interface WorkerState {
  version: 1;
  id: WorkerId;
  status: WorkerStatus;
  turn: number;
  lastCommandSeq: number;
  lastEventSeq: number;
  lastEventAt?: string;
  lastEventOffset?: number;
  /** Durable projection of the currently active turn's causal identity. */
  activeTurn?: {
    turn: number;
    initiatingCommandSeq?: number;
  };
  error?: string;
}
export interface WorkerResult {
  version: 1;
  id: WorkerId;
  instanceId?: string;
  /** Absent on legacy successful results. */
  status?: "completed" | "failed";
  turn: number;
  commandSeq?: number;
  text: string;
  completedAt: string;
  /** Sequence of the event that finalized this result. */
  resultSeq?: number;
  /** @deprecated Use resultSeq. Kept for result.json backward compatibility. */
  eventSeq: number;
  workspace?: WorkspaceMetadata;
}
export type CompletionKind = "turn" | "worker";

export interface WorkerCompletion {
  version: 1;
  kind?: CompletionKind;
  id: WorkerId;
  instanceId?: string;
  turn: number;
  commandSeq?: number;
  /** Event sequence that finalized the result or failure. */
  resultSeq: number;
  status: "completed" | "failed";
  summary: string;
  hasDetails: boolean;
  completedAt: string;
}

/** A globally ordered entry in the durable completion feed. */
export interface CompletionFeedEntry {
  version: 1;
  cursor: number;
  /** Null identifies a CLI/manual worker with no automatic delivery owner. */
  ownerSessionKey: string | null;
  completion: WorkerCompletion;
}

export interface CompletionQuery {
  consumer: string;
  ownerSessionKey: string;
  /** Overrides the consumer's durable checkpoint when supplied. */
  after?: number;
}

export interface WorkerEventsResult {
  version: 1;
  id: WorkerId;
  events: WorkerEvent[];
  fromSeq: number;
  nextSeq?: number | undefined;
  hasMore: boolean;
}

export interface EventHistoryOptions {
  fromSeq?: number | undefined;
  limit?: number | undefined;
}
