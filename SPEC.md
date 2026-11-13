# OpenCode Goals

## Objective
Build a new agent-first, Codex-source-informed goal plugin for the installed OpenCode V2 API. Install it in the local V2 configuration and remove the previous goal plugin from active loading without destroying its data.

## Scope
- Research actual, pinned Codex source and the documented + installed V2 plugin contracts before choosing architecture.
- Native agent tools for goal creation, inspection, revision, planning, checkpoints and lifecycle without requiring a user command or separate approval for goal bookkeeping.
- Human slash commands backed by the same goal service.
- Token-efficient incremental plan append: agents may submit only new steps using `tools.goals.plan` through `execute` with `mode: "append"`; existing steps and evidence remain untouched, with revision checks, unique IDs and the same total plan capacity.
- Durable, session-owned goals with structured acceptance criteria, plan progress, history and evidence-based completion.
- Safe continuation, interruption handling, compaction context, concurrency protection and restart recovery appropriate to the V2 lifecycle.
- Preserve OpenCode's ordinary tool permissions and restricted-agent boundaries. Goal text is task data, not system authority.
- Tests, type checking, build/package verification, integration smoke checks and user documentation.
- Reversible installation with configuration backup and legacy-state preservation.

## Acceptance checks
1. Research documents link pinned Codex implementation and identify concrete adopted/rejected patterns and V2 API constraints.
2. Agents can manage goals directly, including creating and updating them, with no explicit-user-request requirement in plugin policy.
3. Commands and tools share validated state transitions; stale revisions, closed goals, restricted agents and conflicting sessions are handled explicitly.
4. Continuation respects pause/cancel, tool permissions, no-progress, restricted agents and uncertain-delivery fences, and never blindly replays work after restart. There is no turn, active-time or observed-token spending ceiling.
5. Persistence, history, usage accounting, compaction, cancellation and races have behavior-focused coverage.
6. Fresh local checks pass and the installed V2 runtime exposes the replacement tools and commands without the legacy plugin.
7. Documentation includes options, limitations, usage, migration/rollback, and exact verification evidence.

## Non-goals
No V1 compatibility, unrelated configuration changes, deployment/CI work, destructive legacy-data cleanup, or changes to OpenCode itself unless a documented compatibility blocker requires a separately scoped decision.

## Design status
Source research, implementation, incremental append and native V2 integration are verified. Architecture and deliberate Codex divergences are recorded in `docs/design.md` and `docs/codex-research.md`. The higher-budget follow-up below is **superseded** by ceiling-free Goals (retained for history); its installation observation — active in all loaded foreground locations, legacy absent, and all owners belonging to the unchanged foreground process — remains factual history. The earlier deferred managed location converged during normal watched configuration updates without restart, eviction or manual owner changes. Historical evidence and open defects remain in `docs/verification.md` and `docs/feature-verification.md`; finite-ceiling evidence in `docs/budget-verification.md` is **superseded** history.

## Higher default budgets follow-up — SUPERSEDED by ceiling-free Goals

> Historical record, preserved as evidence. The finite ceilings below are no
> longer the contract; current state is `schemaVersion: 2` with `limits: null`,
> no setter/defaults/enforcement, and deprecated ignored `goalLimits`/
> `sessionLimits`. Do not reintroduce numeric ceilings from this section.
The user requested a source-grounded comparison with Codex and higher defaults. New per-goal initial ceilings: **200 admissions, 86,400 active seconds (24 hours), 20,000,000 observed tokens**. New per-session initial ceilings: **1,000 admissions, 604,800 active seconds (7 days), 100,000,000 observed tokens**. These are deliberately finite OpenCode safeguards, not claimed Codex defaults; Codex's goal layer has no turn/time cap and its optional token budget uses different units. Preserve pause/cancel, permission gates, no-progress detection, usage and all previously persisted tighter allowances. New session ceilings apply to new session state; do not silently migrate existing session or goal budgets. Update user documentation and behavior-focused checks, then verify native loading without restarting or evicting the deferred managed server. This follow-up does not silently claim to fix the three defects found during all-feature verification.

## Code Mode tool exposure follow-up
The user requested goal tools through Code Mode, not direct model-visible goal tool registrations. Use the pinned V2 native integration rather than adding an MCP shim or separate service. Agents must be able to discover and invoke all 12 lifecycle operations from `execute`, without duplicate direct `goals_*` tools or a human enablement command. Preserve slash commands, agent-first policy, per-session/location/agent authorization, revision checks, incremental append, usage accounting, recovery and stop behavior. Inspect actual native APIs before selecting the registration change; update scripted acceptance so it exercises Code Mode discovery and invocation rather than assuming direct goal function calls. Acceptance requires focused contract/security checks, fresh types/tests/build, a real isolated V2 search/execute lifecycle and continuation scenario, and installed discovery/execution smoke without model work or underlying permission bypass. The existing unrelated verification findings stay separately tracked. `create`/`revise` advertise no `limits` fields and there is no `increase_limits` operation.

## Fluid autonomous recovery follow-up
Recoverable internal holds must not require manual `/resume_goal --recover` after a turn ends. Active-turn `recover: true` returns scheduled/waiting, not an immediate resume; safe autonomous recovery happens only at observed native idle/background/restart boundaries with reconciled delivery. Ordinary follow-ups are not manual pauses. Background work defers free and completes correlationally once. Explicit stops persist (including legacy conservative inference). `no_progress` needs fresh substantive evidence, not restatements. Failed/interrupted needs new user authorization or explicit request. Unknown delivery is never retried; usage is never refunded or reset and there is no spending ceiling to raise. Legacy budget holds stay held until explicit reconciled resume. Generic defaults stay automation-off. A source bundle backup never rolls back persisted usage/state. See `docs/autonomous-recovery-spec.md` and `docs/autonomous-recovery-verification.md`.

## Explicit agent limit increases follow-up — SUPERSEDED by ceiling-free Goals

> Historical record, preserved as evidence. The `increase_limits` design below
> is removed from source/tool/RPC/runtime (12 lifecycle operations);
> `create`/`revise` reject `limits` input and there are no numeric ceilings,
> grants, clamps or enforcement. Do not reintroduce this API from this section.

The user permits agents to raise limits independently, with no per-increase approval. New Code Mode and typed RPC `increase_limits` accepts `goalId`, `expectedRevision`, required `reason`, and `limits` and/or `sessionLimits` patches. Patch values are absolute new ceilings, not deltas: every provided dimension must be nondecreasing, at least one ceiling must actually increase, and empty/no-op patches are rejected. Requires trusted `executionAllowed`; `create`/`revise` stay tighten-only. Each raised field persists as a field-specific `limitGrants` entry on the goal and/or session allowance, overriding a later-lowered configured initial value for that field only; reload clamps to `min(current, max(config, grant))` so a tightened current limit is never refilled. Session grants survive goal replacement; goal grants do not carry into the replacement. There is no API to reduce a session grant and configured initial values do not revoke it; explicit pause/cancel still stops. The increase writes the exact structured `history.limitChange` before/after atomically in the same envelope write/revision bump, adds no progress, preserves scope/evidence/usage/generation/reservations/stops, and never wakes or resumes. A budget-paused goal stays paused; only a separate `resume` with trusted native reconciliation (`recover: true`) after a sufficient increase can resume, and exhausted limits still reject resume. Old records remain accepted; old strict readers reject the new grant/history metadata, so downgrade is unsupported without a compatible migration and must preserve usage/state with no state rollback. Agent-self-raisable limits are admission thresholds, not a hard spend cap; overshoot and host-bound child-session accounting caveats are unchanged.

## Ceiling-free Goals — current contract

Remove all goal/session admission-count, active-time and observed-token
ceilings (see `docs/unbounded-goals-spec.md`). New state is `schemaVersion: 2`
with goal/session `limits: null`; usage, high-water accounting, active elapsed
time and charged admissions remain cumulative with no resets/refunds. Legacy
`goalLimits`/`sessionLimits` config is accepted but ignored;
`create`/`revise` reject `limits` input and `increase_limits` is removed (12
lifecycle operations). Legacy budget holds stay held for explicit reconciled
resume; all non-budget safeguards remain. Diagnostics are usage-accounting-only.

## Per-server plugin isolation follow-up
The goals plugin must bind to the OpenCode server process that loaded it, without relying on one globally configured port, and every server instance must own independent goal persistence and scheduling locks. Prefer a matching local managed-service registration for its own PID; otherwise discover only an unambiguous literal-loopback listener owned by the current process, then verify `/api/info.pid` and the pinned version before any ownership or goal-storage access. An explicit loopback URL may select only a process-owned listener and may preserve the existing legacy namespace; it is never contacted without process-ownership proof. Fail closed when process identity is unavailable; never send credentials to a foreign listener or silently switch bindings after verification. Use one stable logical namespace for both state and locks (service registration path for managed service, canonical endpoint for explicit listeners). Preserve the existing foreground server's legacy key and lock paths exactly; do not migrate, copy, inspect, reclaim, or remove its live state while adding the service namespace. No process stop/restart or service lifecycle mutation is in scope. Acceptance requires fixture-driven binding/namespace/security tests, fresh types/build/focused tests, and observable activation proving the legacy foreground server and the default service are active simultaneously, with separate namespaces and unchanged legacy process/state/owner evidence. Underlying OpenCode database/session identity remains shared; this follow-up guarantees plugin-owned state and bridge target isolation, not separate native sessions.

## Goals-only restoration — current work

Per [goals-only restoration](docs/goals-only-spec.md), the board-only
`goals.snapshot` RPC, its schemas, `service.peek`, and
`runtime.passiveSnapshot` are removed from this plugin; the twelve native
Goals lifecycle operations, typed `GoalsRPC`, slash commands, persistence,
usage accounting, and continuation safeguards are preserved. The
[passive workstreams telemetry](docs/passive-workstreams-telemetry.md)
document is retained as superseded history, not the current contract. The
separate Workboard/state-manager application is unchanged by this work.
The restored build targets exact OpenCode/SDK `2.0.32`. Rebuild, test, isolated
native acceptance, and same-process watched activation evidence is recorded in
[goals-only verification](docs/goals-only-verification.md); the coordinator
owns the roadmap and exact verification/activation status.

## Command contract
- `/goal` and `/goal status` inspect the current goal; `/goal help` documents syntax, and `/goal history` reports retained lifecycle history.
- `/goal create <objective>` explicitly creates a goal with a full-objective acceptance criterion and deliberately requests a guarded start. Unknown words never implicitly create or replace a goal.
- `/goal pause [reason]`, `/goal cancel [reason]`, and `/goal clear [reason]` stop future automation; clear is a history-preserving cancellation alias, not deletion.
- `/goal resume` requests ordinary resume plus a guarded start. `/goal resume --recover` requests adapter reconciliation, not permission to bypass a safety hold. Reconciliation must inspect actual native state.
- `/pause_goal` and `/resume_goal` preserve familiar aliases. Advanced structured plans, criteria and evidence use the agent tools or typed RPC rather than a brittle shell-like command grammar.
- Read-only and stop commands never wake a model. V2 2.0.25 has no immediate command-output surface: passive notices are queued synthetic context (`resume:false`), not an already-delivered transcript message. Successful create/resume starts must not add a competing passive notice ahead of their own admission.
