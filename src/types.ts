export type WorkerId = string & { readonly __workerId: unique symbol };

export function workerId(value: string): WorkerId {
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(value)) {
    throw new SubagentError("INVALID_WORKER_ID", `Invalid worker id: ${value}`);
  }
  return value as WorkerId;
}

export class SubagentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SubagentError";
  }
}

export type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };
