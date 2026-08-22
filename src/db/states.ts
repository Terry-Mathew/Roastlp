type StateGraph<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export class InvalidStateTransitionError<State extends string> extends Error {
  constructor(
    readonly entity: string,
    readonly from: State,
    readonly to: State,
  ) {
    super(`Invalid ${entity} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export const roastTransitions = {
  awaiting_payment: ["ready_for_fulfillment", "terminal_failure", "deleted"],
  ready_for_fulfillment: ["queued", "refund_pending", "terminal_failure"],
  queued: ["processing", "refund_pending", "terminal_failure"],
  processing: ["completed", "refund_pending", "terminal_failure"],
  completed: ["deleted"],
  terminal_failure: ["refund_pending", "deleted"],
  refund_pending: ["refunded"],
  refunded: ["deleted"],
  deleted: [],
} as const satisfies StateGraph<
  | "awaiting_payment"
  | "ready_for_fulfillment"
  | "queued"
  | "processing"
  | "completed"
  | "terminal_failure"
  | "refund_pending"
  | "refunded"
  | "deleted"
>;

export const paymentTransitions = {
  created: ["authorized", "captured", "failed"],
  authorized: ["captured", "failed"],
  captured: ["partially_refunded", "refunded"],
  failed: [],
  partially_refunded: ["refunded"],
  refunded: [],
} as const satisfies StateGraph<
  | "created"
  | "authorized"
  | "captured"
  | "failed"
  | "partially_refunded"
  | "refunded"
>;

export const auditJobTransitions = {
  pending: ["leased", "cancelled"],
  leased: ["retry_scheduled", "succeeded", "failed"],
  retry_scheduled: ["leased", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const satisfies StateGraph<
  | "pending"
  | "leased"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "cancelled"
>;

export const jobAttemptTransitions = {
  running: ["succeeded", "retryable_failure", "terminal_failure"],
  succeeded: [],
  retryable_failure: [],
  terminal_failure: [],
} as const satisfies StateGraph<
  "running" | "succeeded" | "retryable_failure" | "terminal_failure"
>;

export const webhookTransitions = {
  received: ["processing", "rejected"],
  processing: ["processed", "failed"],
  processed: [],
  failed: ["processing", "rejected"],
  rejected: [],
} as const satisfies StateGraph<
  "received" | "processing" | "processed" | "failed" | "rejected"
>;

export const refundTransitions = {
  requested: ["processing", "succeeded", "failed"],
  processing: ["succeeded", "failed"],
  succeeded: [],
  failed: ["processing"],
} as const satisfies StateGraph<
  "requested" | "processing" | "succeeded" | "failed"
>;

export function assertStateTransition<State extends string>(
  entity: string,
  graph: StateGraph<State>,
  from: State,
  to: State,
): void {
  if (from === to || !graph[from].includes(to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }
}
