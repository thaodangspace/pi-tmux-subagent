import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Manager } from "../manager/manager.js";
import type { WorkerCompletion } from "../protocol/types.js";

export interface SubagentCompletionPayload {
  type: "subagent_completed";
  /** Stable idempotency key for duplicate enqueue/redelivery handling. */
  completionKey: string;
  id: string;
  turn: number;
  commandSeq?: number;
  resultSeq: number;
  status: "completed" | "failed";
  summary: string;
  hasDetails: boolean;
}

export function formatCompletionNotification(
  completion: WorkerCompletion,
): string {
  return [
    `[subagent ${completion.id} ${completion.status}]`,
    completion.summary,
    `Full result available via subagent({ action: "result", id: "${completion.id}", turn: ${completion.turn}, resultSeq: ${completion.resultSeq} }).`,
  ].join("\n");
}

export function subagentCompletionPayload(
  completion: WorkerCompletion,
): SubagentCompletionPayload {
  return {
    type: "subagent_completed",
    completionKey: `${completion.id}:${completion.turn}:${completion.resultSeq}:${completion.status}`,
    id: completion.id,
    turn: completion.turn,
    ...(completion.commandSeq !== undefined
      ? { commandSeq: completion.commandSeq }
      : {}),
    resultSeq: completion.resultSeq,
    status: completion.status,
    summary: completion.summary,
    hasDetails: completion.hasDetails,
  };
}

export interface CompletionNotifierOptions {
  ownerSessionKey: string;
  consumer?: string;
  intervalMs?: number;
  autoRecover?: boolean;
  onError?: (error: unknown) => void;
  deliveryOptions?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  };
}

export class CompletionNotifier {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private running = false;
  private delivering: Promise<void> | undefined;
  private readonly consumer: string;
  private readonly intervalMs: number;

  constructor(
    private readonly manager: Manager,
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly options: CompletionNotifierOptions,
  ) {
    const ownerHash = createHash("sha256")
      .update(options.ownerSessionKey)
      .digest("hex")
      .slice(0, 24);
    this.consumer = options.consumer ?? `pi-extension-${ownerHash}`;
    this.intervalMs = options.intervalMs ?? 500;
  }

  async start(): Promise<void> {
    if (this.disposed || this.running) return;
    this.running = true;
    await this.poll();
    this.schedule();
  }

  async poll(): Promise<void> {
    if (this.disposed) return;
    if (this.delivering) return this.delivering;
    this.delivering = this.performPoll().finally(() => {
      this.delivering = undefined;
    });
    return this.delivering;
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.disposed || !this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async performPoll(): Promise<void> {
    try {
      if (
        this.options.autoRecover !== false &&
        typeof this.manager.list === "function"
      ) {
        await this.manager.list().catch(() => undefined);
      }
      const entries = await this.manager.completions({
        consumer: this.consumer,
        ownerSessionKey: this.options.ownerSessionKey,
      });
      const validEntries = entries.filter(
        (e) =>
          e.completion.status === "completed" ||
          e.completion.status === "failed",
      );
      const unhandledEntries = entries.filter(
        (e) =>
          e.completion.status !== "completed" &&
          e.completion.status !== "failed",
      );
      for (const entry of unhandledEntries) {
        await this.manager.ackCompletion(
          this.consumer,
          this.options.ownerSessionKey,
          entry.cursor,
        );
      }

      const triggerTurnPolicy = this.options.deliveryOptions?.triggerTurn ?? true;
      const deliverAs = this.options.deliveryOptions?.deliverAs ?? "followUp";

      for (let i = 0; i < validEntries.length; i++) {
        if (this.disposed) break;
        const entry = validEntries[i]!;
        const completion = entry.completion;
        const isLast = i === validEntries.length - 1;
        const shouldTrigger = isLast && triggerTurnPolicy;

        const payload = subagentCompletionPayload(completion);
        const content = formatCompletionNotification(completion);

        this.pi.sendMessage(
          {
            customType: "subagent_completed",
            content,
            display: true,
            details: payload,
          },
          {
            deliverAs,
            triggerTurn: shouldTrigger,
          },
        );

        // Pi exposes only synchronous enqueue, not durable delivery confirmation.
        // Checkpoint after enqueue returns; detectable throws remain retryable.
        await this.manager.ackCompletion(
          this.consumer,
          this.options.ownerSessionKey,
          entry.cursor,
        );
      }
    } catch (error) {
      if (this.options.onError) this.options.onError(error);
      else console.error("Completion notifier poll failed", error);
    }
  }
}
