export type GoalErrorCode =
  | "validation" | "corrupt_state" | "storage" | "disposed"
  | "conflict" | "no_goal" | "wrong_goal" | "stale_revision"
  | "closed_goal" | "invalid_transition" | "plan_preservation"
  | "evidence_required" | "execution_restricted"
  | "recovery_required" | "dispatch_pending";

/** Stable, adapter-neutral failures. Never expose stored task text in diagnostics. */
export class GoalError extends Error {
  constructor(readonly code: GoalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoalError";
  }
}
