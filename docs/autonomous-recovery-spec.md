# Fluid autonomous goal continuation

## Requested outcome

Recoverable internal holds must not require a person to issue `/resume_goal --recover` after the agent's turn ends. Preserve the user's ability to pause/cancel, genuine blockers, permission boundaries, no-progress safeguards and uncertain-delivery fences. There are no turn, active-time or observed-token spending ceilings; usage accounting only is retained and legacy budget holds stay held until explicit reconciled resume. Integrate, rather than overwrite, the already-reviewed source-only background-wait fix and activate the verified combination without restarting live servers.

## Observed diagnosis

The reported Trim integration session's native goal history shows: a system-generated manual pause on ordinary follow-up input; restart recovery; explicit human resume; two repeated automatic reservations while background work was pending; then `no_progress` pause at revision 17. Checkpoint/evidence updates subsequently advanced revisions 18 and 19 while it remained paused. The latest observed goal was paused/no_progress with nine charged admissions. This is not evidence of an explicit human pause. At diagnosis, the other session's background-deferral source and its reviewed staged bundle were not yet the installed root bundle.

At diagnosis, `guardPrompt` paused an active goal on all foreign user input. `reconcile` required an idle session even when the caller was an agent executing inside that session, rejecting its own caller. `start` likewise rejected active execution. The reviewed background fix alone still left internal recovery and ordinary follow-up holds requiring manual intervention. That background-only bundle was activated by concurrent authorized work during this isolated implementation; preserve its evidence and combine, rather than revert, its behavior.

## Acceptance

1. Agent-requested recovery from an active turn returns an honest deferred/scheduled result instead of directing the user to wait and enter another command. At a native idle boundary, fresh same-server reconciliation can resume and admit one new continuation. Never replay or refund an old dispatch.
2. Recoverable internal holds can be reconsidered automatically on authoritative runtime observations/boundaries. Restart or transient runtime failure needs healthy ownership/observation and reconciled delivery. No-progress recovery requires newly reported substantive progress, not a status restatement. No unconditional retry of failed/interrupted work.
3. Ordinary follow-ups invalidate stale automation and yield to the user without silently turning the goal into a manual pause. New pending user input, forms, permissions and background work win; the goal remains maintainable and can continue once its current authorized work reaches a safe boundary.
4. Keep the reviewed background fix: running native owned shells/direct children defer without a pre-reservation charge or spam; correlated completion rechecks once. Retain the conservative charged/no-delivery behavior for late-arrival races.
5. Explicit pause/cancel/block, legacy budget holds, restricted or foreign sessions, unknown delivery, no new progress and failed observation remain effective. Explicit stops must remain stops across reload even when an outstanding dispatch exists; a restart-reason rewrite must not erase human intent. No usage resets; there is no spending-ceiling API and legacy holds are never auto-resumed.
6. No waiting on the caller's own idle while blocking its tool response; no polling/timer prompt loop, fabricated progress or hidden permission bypass. Pending work is bounded, lifecycle-fenced and coalesced.
7. Focused behavior/fault regressions, actual isolated V2 active-turn recovery, follow-up, restart and background flows, and an independent full-verifier pass cover the integrated change. Preserve the old installed bundle/config privately; verify native watcher activation and live ownership without restart, eviction or live-lock deletion.

## Scope and work ownership

The directory is not a Git repository. Do not initialize/publish it merely to satisfy PR conventions. A private baseline is retained under `<private-path>`. Implementation will use an isolated copy first to avoid colliding with the other session's still-running read-only background verifier. Before integration, compare touched originals with the saved baseline and preserve concurrent changes.

Out of scope: trim implementation, replaying cancelled worker tasks, unrelated historical defects or retention redesign, model/provider billing, server restarts and implicit migration of saved usage. The finite-ceiling removal once listed here is now done under `docs/unbounded-goals-spec.md` (current contract: `schemaVersion: 2`, `limits: null`). Historical bookkeeping in the coordinator's old session legitimately held a legacy lifetime stop; preserve that stop intent rather than resetting usage to make an integration test pass. The fresh user request, not paused-goal text, authorizes this implementation work.
