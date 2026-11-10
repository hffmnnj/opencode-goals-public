# Explicit agent limit increases

Superseded by the user's later “Remove limits entirely” instruction. This file
records the earlier design, not the implementation target. See
[Ceiling-free Goals](unbounded-goals-spec.md). Its candidate was not activated.

## Goal and authority

User request: “Add support for agents to increase limits.” The user selected
“Agents may raise” rather than approval for each increase. Permitted execution
agents may explicitly raise existing goal and session ceilings for authorized
work. This does not authorize more work, reset usage, approve tools, or resume
execution.

## Operation contract

`increase_limits` targets one open current goal by `goalId` plus the current
content `expectedRevision`, with a required `reason` and a `limits` and/or
`sessionLimits` patch. Patch values are absolute new ceilings, not deltas or
credits. Every provided dimension must be nondecreasing against the stored
current ceiling; at least one provided ceiling must actually increase.
Empty patches and any decrease are rejected, as are stale/wrong/closed
targets and callers without trusted `executionAllowed`. Caller-supplied
identity, token accounting, or recovery assertions are never accepted.
`create` and `revise` remain tighten-only.

The increase applies atomically with the audit in the same envelope
write/revision bump: the exact structured `history.limitChange`
`{ before: { limits, sessionLimits }, after: { limits, sessionLimits } }` is
written with the ceiling change, the envelope and content revisions advance
together, and no progress counter is incremented. History remains bounded by
`maxHistory`; later audit eviction does not revoke an existing grant.
Scope, evidence, progress, generation,
reservations, high-water marks, stop intent, and all usage survive; newly
observed usage may still be charged.

## Grant persistence and precedence

Each raised field persists as an optional field-specific `limitGrants` entry
on the goal (`Goal.limitGrants`) and/or the session allowance
(`allowance.limitGrants`), separate from configured initial ceilings. A grant
overrides a later-lowered configured initial value for that granted field
only; non-granted fields keep the existing minimum-on-load behavior. Reload
clamps every field to `min(current, max(config, grant))`, so a `revise`
tightening of the current limit is never refilled by reload. Session grants
survive goal replacement; goal grants do not carry into the replacement goal.
There is no API to reduce a session grant and configured initial values do
not revoke it; explicit pause/cancel still stops.

## Resume, downgrade, and accounting limits

An increase never wakes or resumes execution on its own. A budget-paused goal
stays paused; after a sufficient increase, a separate explicit `resume` with
trusted native reconciliation (`recover: true`) may resume, and exhausted
limits still reject resume. Manual stops, ambiguity, and other holds remain
enforced; runtime reconciliation still applies.

Old records without grants remain accepted. Old strict readers reject the new
grant/history metadata, so downgrade is unsupported without a compatible
migration: any downgrade path must preserve usage/state and must not roll
back state.

Agent-self-raisable limits are admission thresholds, not a hard spend cap.
Overshoot remains possible and the plugin charges only what V2 reports for
the bound host session (no independent child-session aggregation).

## Scope

- Add Code Mode and typed RPC `increase_limits`, targeting an open current goal
  by ID and content revision, with a required reason and `limits` and/or
  `sessionLimits` patches. Values are finite, positive, safe-range limits;
  turns/tokens are integers. Reject empty/no-op patches and any decrease.
- Require trusted `executionAllowed`; never accept caller identity or recovery
  assertions. Keep `create` and `revise` tighten-only.
- Preserve goal scope, evidence, progress, generation, reservations, high-water
  marks, stop intent and all usage. Accounting may add newly observed usage.
- Persist explicit per-field increases separately from configured initial
  ceilings so reload cannot silently erase them. Non-increased fields retain
  the existing minimum-on-load behavior. Explicit grants override configured
  initial ceilings only for granted fields; reads never restore tightened limits.
  Goal grants do not carry into replacement goals; session grants do.
- Audit the reason and before/after limits without marking task progress.
- A budget-paused goal stays paused. After sufficient increases, explicit
  `resume` with trusted native reconciliation can resume; exhausted limits still
  reject resume. Manual stops, ambiguity and other holds remain enforced.

## Exclusions

No state-file editing, usage refunds, automatic budget increases, new permission
approval prompt, implicit resume, server restart, ownership migration, unrelated
defect fixes, or publication/activation of staged per-server isolation work.
This existing project has no Git repository; no Git initialization or publication
is part of this change.

## Acceptance checks

1. Service tests cover every limit dimension, goal/session patches, invalid and
   decreasing/no-op inputs, stale/wrong/closed targets, restricted agents,
   serialized conflicts and storage failures.
2. Preservation and reload tests prove charged usage/high-water/reservations,
   scope/evidence/progress/stops survive, grants persist, replacement inheritance
   is correct, and legacy/default/revise tightening behavior is unchanged.
3. Runtime/native-registration tests prove Code Mode/RPC discovery, trusted
   context and guarded budget resume without automatic wake or stop bypass.
4. Fresh typecheck, complete local test suite, external candidate build and
   independent security/behavior verification. Do not overwrite live `dist` or
   entrypoint during source verification.
5. README describes operation, persisted grant/config semantics and resume
   behavior. Verification report states exact commands and live activation status.

## Workstreams

Coordinator owns specification/integration. Engineer owns state-machine/API and
focused security tests. Minion follows sequentially for decided documentation
and routine acceptance-script updates. Full-verifier independently audits the
finished change read-only. One writer at a time; no nested workers.
