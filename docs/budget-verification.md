# Higher default budgets: verification

> **Superseded.** Ceiling-free Goals is the current contract. The finite default ceilings recorded here are historical and must not be reintroduced as current behavior.

## Source-grounded decision

Codex comparison and pinned citations are in [Codex research](codex-research.md#default-budgets-compared-with-this-plugin). The historical finite defaults were goal **200 admissions / 86,400 active seconds / 20,000,000 observed tokens** and session **1,000 admissions / 604,800 active seconds / 100,000,000 observed tokens**. Active time includes idle wall-clock time while status is active, not only model execution. Existing persisted ceilings and usage were not migrated upward; a new session was needed for the new lifetime session ceiling. Permission, stop, no-progress and recovery behavior were unchanged.

## Fresh checks

- Full local check: strict types passed, **151 tests passed, 0 failed, 1,115 assertions**, build passed.
- Eight added public-service tests exercised persisted new ceilings, crossing old token/time/admission thresholds, active and paused old state across reload, replacement retaining session consumption, tightening, and stopping at the goal token ceiling. Five relevant failures were observed after temporarily restoring old defaults; the new constants were restored and the suite reran green. Redundant constant-only assertions were later removed, fixture configuration types were strengthened, and the full check was rerun independently.
- Watcher lifecycle scenario: **18 checks passed**, including all 12 RPC methods, incremental append, passive commands, restart and watched reload.
- Native preflight: six scripted provider requests, two successful native executions, from agent creation through automatic continuation, evidence and completion. This verifies real V2 wiring against a deterministic local protocol fixture, not external-model judgment.
- Live foreground V2 2.0.25 inspection: a fresh explicitly located session received the exact new goal and session ceilings, zero admissions and tokens, and was cancelled after inspection. Inbox and context remained empty, with no model execution.

## Installed configuration and ownership

Matching `goalLimits` and `sessionLimits` were added only to the existing goal plugin options. Exact before/after comparison confirmed all other settings and plugins unchanged, and the configuration file kept private permissions. A private backup and the complete check/live evidence were retained outside the project.

The first final-inventory assertion expected the previously deferred location to remain failed, but it was **active**. Read-only diagnosis confirmed the correct response location, all three commands, both original server processes alive, and all ownership records now belonging to the foreground. A full inventory then verified the replacement active with commands in **all loaded locations** and legacy absent everywhere. This supersedes the earlier partial checkpoint. During the ordinary watched configuration update, ownership converged without coordinator restart, scoped eviction, owner-file manipulation or form/permission replies. The precise internal timing of the prior owner's release was not traced, and managed forms were not independently re-audited in this follow-up.

The three unrelated defects in [all-feature verification](feature-verification.md) remain open; this budget change did not fix them. No exactly-once, hard billing-cap or exhaustive-feature-correctness claim is made.
