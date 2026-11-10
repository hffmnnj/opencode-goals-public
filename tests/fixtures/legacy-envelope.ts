import type { SessionEnvelope } from "../../src/schema.ts";

export const legacyGoalLimits = { maxAutoTurns: 200, maxDurationSeconds: 86_400, tokenBudget: 20_000_000 };
export const legacySessionLimits = { maxAutoTurns: 1000, maxDurationSeconds: 604_800, tokenBudget: 100_000_000 };

/** Genuine v1 JSON shape, including optional historical grants, not a v2 record with a changed version. */
export function legacyEnvelope(state: SessionEnvelope, grants = false) {
  const goal = (record: NonNullable<SessionEnvelope["current"]>) => ({
    ...structuredClone(record), limits: { ...legacyGoalLimits },
    ...(grants ? { limitGrants: { tokenBudget: 30_000_000 } } : {}),
  });
  return {
    ...structuredClone(state), schemaVersion: 1 as const,
    current: state.current ? goal(state.current) : null, archives: state.archives.map(goal),
    allowance: { ...structuredClone(state.allowance), limits: { ...legacySessionLimits },
      ...(grants ? { limitGrants: { tokenBudget: 110_000_000 } } : {}) },
  };
}
