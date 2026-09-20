import type { WorkerId } from "../types.js";

export const PROTOCOL_VERSION = 1 as const;
export type WorkerStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "stopped" | "orphaned";
export type WorkspaceMode = "current" | "worktree";
export interface WorkspaceMetadata { mode: WorkspaceMode; root: string; branch?: string; worktree?: string; commit?: string; changedFiles?: string[] }
export interface LaunchConfig { task: string; name?: string; model?: string; thinking?: string; tools?: string[]; systemPrompt?: string; workspace?: WorkspaceMode; depth?: number; maxDepth?: number; rpcArgs?: string[] }
export interface WorkerMeta { version: 1; id: WorkerId; tmuxSession: string; createdAt: string; cwd: string; launch: LaunchConfig; runnerPid?: number; piPid?: number; heartbeatAt?: string; workspace?: WorkspaceMetadata }
export type WorkerCommand =
  | { version: 1; seq: number; at: string; type: "prompt" | "send" | "steer"; text: string }
  | { version: 1; seq: number; at: string; type: "abort" | "stop" };
export interface WorkerEvent { version: 1; seq: number; at: string; type: string; commandSeq?: number; data?: unknown }
export interface WorkerState { version: 1; id: WorkerId; status: WorkerStatus; turn: number; lastCommandSeq: number; lastEventSeq: number; lastEventAt?: string; error?: string }
export interface WorkerResult { version: 1; id: WorkerId; text: string; completedAt: string; eventSeq: number; workspace?: WorkspaceMetadata }
