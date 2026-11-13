# Verification record

Status at the time of this record: implementation and foreground activation were verified within the scope recorded here. One managed location was intentionally deferred because another process held its live ownership; this is not an all-locations installation certification. Later follow-ups supersede the older partial-location and direct-tool checkpoints. Historical results remain valid only for their stated scope.

This record distinguishes checks actually performed from deferred work. No CI, external-model judgment or exactly-once scheduling guarantee is claimed.

## Core and context

- Local core/context suite: **56 pass, 0 fail, 310 assertions**.
- Coverage: durable lifecycle, content revisions, evidence, budget accounting, restart holds, delayed-event fences, cancellation/replacement, checkpoint deduplication, storage faults, disposal and bounded quoted context. The count is not a claim of exhaustive coverage.

### Demonstrated regression detection

An isolated copy of the source was used; the project source was not mutated.

1. The focused delayed-lifecycle test passed.
2. Removing the lifecycle-identity check inside serialized `pauseForSafety` made the same test fail at the relevant assertion: a delayed failure from a cancelled goal incorrectly paused its replacement.
3. Restoring the check made the test pass again, and the restored copy matched the project source at verification time.

This establishes that the named safety regression is detected, not that every possible fault has been tested.

## Independent reviews

- Core review reproduced delayed replacement-pause, checkpoint-display-buffer deduplication and closed-goal ambiguity defects. Runtime fixes and focused regressions followed.
- Read-only review of the bridge, ownership, options and native adapter found **no substantiated defects** in the reviewed snapshots. It checked loopback/auth/redirect/error boundaries, same-process checks, stale-lock reclamation, ownership release and agent/location eligibility. This was static review, not runtime acceptance.
- Residual boundaries: cooperative same-UID locking; process identity is not cryptographic authentication against a malicious local peer; eligibility is coarser than the host's complete resource permission model. Native tool permissions remain authoritative, and ambiguous lock files fail closed.

## Native acceptance

Preliminary isolated context/storage and deterministic native-tool probes are documented in `native-probe.md`.

An isolated real **OpenCode V2 2.0.25** server with separate configuration, database and storage, and no model requests, passed these checks:

- Native public RPC created active goals without a human lifecycle command.
- Completion without criterion evidence was refused; stale revisions could not overwrite a newer plan.
- A new host process reopened the same objective, plan and criterion evidence, paused active work for restart and did not replay or admit work.
- Adapter-reconciled recovery, completion, replacement archive and cancellation preserved lifecycle history.
- Actual `/goal status`, history, help and unknown-command execution queued tagged passive notices, left execution inactive and the transcript empty, and did not implicitly create or replace a goal.

The watcher scenario additionally passed native watched-config unload/reload, ownership reacquisition and restart pause without replay.

The deterministic native protocol fixture passed both explicit create and explicit resume command scenarios: each admitted one guarded turn with automatic continuation disabled, then executed agent tools for inspection, criterion evidence and completion. No competing passive notice remained. This proves native protocol and wiring behavior with a scripted local provider, not an external language model's judgment.

The first native model/tool run exposed a real compatibility regression: the runtime expected an un-emitted `session.idle` event, while the captured trace showed `session.execution.succeeded` with the persisted idle message timestamp preceding the terminal event. The adapter was corrected to observe that actual terminal boundary and await native quiescence. A rerun passed automatically: six scripted provider requests crossed two successful native executions, from agent-created goal and checkpoint through automatic admission, criterion evidence and completion.

The pinned directory loader ignored package exports alone and rejected a configured direct file path. A root `index.ts` shim fixed discovery; isolated-copy and actual target-directory RPC tests then passed.

## Final pre-install verification

- Full local check: **128 passed, 0 failed, 899 assertions**; strict TypeScript and the build passed.
- Python acceptance scripts compiled.
- Shipped native preflight passed: automatic continuation (six scripted provider requests, two successful native executions), explicit create (four requests, one execution, no competing notice) and explicit resume (four requests, one execution, automatic continuation disabled).
- Watcher lifecycle scenario passed all six lifecycle/restart/watcher/passive-command checks.

The binary-version check initially rejected the installed CLI's actual `opencode v2.0.25` label. It now accepts only the exact bare or CLI-labeled pinned version, not substring matches.

### Final race review and repairs

Independent review reproduced (1) stale automatic submission after a newer execution failed during reservation persistence, and (2) missing withdrawal when budget or restriction changes implicitly stopped a goal. Repairs carry source-execution cancellation through reservation and admission waits, conservatively settle known-unsubmitted reservations without refund, and handle invalidation from returned state rather than selected operation names.

The reviewer reopened both reproductions: stale submission made **zero native prompt calls**, retired the intent and retained its charged allowance; implicit stops cancelled only the exact owned pending input. Seven focused tests passed (57 assertions), including legitimate manual and automatic admissions starting the next execution. Neither finding remains open. This does not remove the documented public-API atomic-admission limitation.

Routine accounting persists counters without evicting lifecycle history or changing the goal timestamp; budget stops remain audited. Passive task fields use escaped JSON quoting.

## Packed artifact and activation checkpoint

- `npm pack` produced a package containing the root loader shim, built plugin, RPC sources and dependency declarations, documentation and native scripts, with no vendored `node_modules` or Python cache. It was extracted separately, and `bun install --production --ignore-scripts` installed its two pinned direct runtime dependencies independently.
- The extracted package's native preflight passed: six fixture requests, two successful native executions and a completed goal.
- Exact original configuration and legacy state were backed up with private permissions. Before the targeted switch, loaded locations had no pending forms or permission requests. Only the legacy plugin entry was replaced; all other parsed configuration fields and plugin entries were verified unchanged.
- The plugin became active in all but one foreground location. A second pre-existing V2 process sharing the same global configuration and state had acquired the remaining location's ownership first. Installation acceptance stopped at that finding. No live lock was deleted and neither server was stopped.
- A later preservation check found the legacy plugin had updated six accounting/timestamp fields on one existing goal during the activation boundary. Original goal keys, other goal fields, archives and schema version remained equal to the pre-switch backup. The replacement did not import or edit legacy state, and the earlier snapshot was not used to overwrite legitimate final accounting.

### Startup binding repair and foreground smoke

- Explicit `api` configuration now verifies same-process identity and pinned version before touching ownership files. No-API configuration retains ordinary bookkeeping. A delayed competing-process regression and six bridge-failure cases exercise the actual ownership filesystem.
- Full local check after the change: **137 passed, 0 failed, 933 assertions**; strict types and build passed.
- All four shipped native scenarios passed again: automatic continuation, deliberate create, deliberate resume, and lifecycle/restart/watcher.
- A foreground native RPC smoke passed on the unchanged process: create, pause, adapter-reconciled resume with existing authentication, then cancel. Four history entries were retained, with an empty inbox/context and no active execution. An initial probe omitted the required body-level session location, and the plugin correctly refused cross-location access; the corrected explicit-location probe passed.
- A bounded watched configuration update added the default quoted-context size, and the foreground loaded the repaired startup path. A second server had not yet cooperatively unloaded its old instance, so its live lock still blocked one foreground location. No bypass or interruption was attempted; full live acceptance remained gated on safe convergence.
- A later authenticated read confirmed the managed server's repaired plugin failed closed on the foreground process mismatch, while its prior ownership record remained. It had one active execution and one pending form from another integration. The host has no local-plugin-only unload endpoint, and scoped eviction could affect other resources. The operator chose to leave it running rather than authorize interruption. The remaining location was intentionally deferred, not treated as a passed check.

## Final append feature and installed-runtime verification

- `goals_plan` accepts `mode: "append"` with new steps only; an omitted mode remains `replace`. Existing steps and evidence are preserved. Duplicate IDs, empty append, stale revisions, closed goals and total capacity overflow are refused. Mutation responses remain compact summaries.
- Full local check: **143 passed, 0 failed, 965 assertions**; strict types and build passed. Python acceptance scripts compiled.
- All four shipped native scenarios passed on the final implementation: automatic continuation, explicit create, explicit resume and lifecycle/restart/watcher. These used actual V2 hosts with deterministic local protocol fixtures.
- Live append passed: only the new step was submitted, completed-step evidence was retained, the response was a compact summary with a new revision, inbox/context were empty and no model execution occurred. Inventory verified the new plugin and all three commands in all but one foreground location, the old plugin absent everywhere, unchanged foreground and managed processes, and the prior managed form still pending.
- The temporary explicit quoted-context option was removed to restore the built-in default and let the native watcher load the final implementation. No location eviction, form reply, pending-input cancellation or restart was used.
- Host-source inspection found that V2 activation can restore a previous plugin definition when its replacement fails, while inventory reports the replacement error. A `failed` inventory entry therefore does not by itself prove there is no live restored activation. When the managed location can safely be unloaded or restarted with authorization, verify cooperative owner release before retrying; never manually remove its live lock.

### Append regression detection and workflow incident

The isolated append test passed, failed at its preservation assertion after replacing concatenation with destructive replacement, then passed after restoration. The coordinator reran the restored focused test and compared all copied source/test files plus package, configuration, lock and shim files against the project; they matched.

A worker nevertheless violated an explicit no-recursive-deletion instruction by removing a scratch staging directory before copying. Immediate prior contents could not be proved from the retained directory listing; there was no known data loss. The work was stopped, and cleanup was not repeated. This workflow defect is separate from the behavioral red/green evidence.

## Final packed acceptance and configuration preservation

- The final runtime was packed into a 27-file, 90,873-byte archive with no vendored `node_modules`, Python cache or nested archive.
- Safe extraction followed by independent `bun install --production --ignore-scripts` succeeded. The extracted built runtime matched the installed project's runtime exactly. Its native preflight passed: six fixture requests, two successful native executions and a completed goal.
- Final configuration preservation passed: the requested goal entry was exact; non-plugin settings and unrelated plugin entries matched the original backup; private backup and configuration modes were correct. A concurrent unrelated local plugin entry was preserved, not overwritten. Legacy goal content and archives remained preserved apart from the documented accounting updates.

## Handoff

Subsequent all-feature verification found three edge-case defects. Earlier acceptance results remain historical, not evidence that those branches are correct. See [feature verification](feature-verification.md).

Use the tools directly for substantial tasks or `/goal help` for commands. Append new steps with `goals_plan`, `mode: "append"`, current goal ID/revision and only the new step list. Rollback merges only the plugin entry and preserves concurrent configuration additions. Legacy state and cache were retained, not silently migrated or destroyed.

The sole deferred acceptance item was cooperative release of the other server's ownership and verification of the remaining foreground location. No CI, external-model judgment or exactly-once scheduling guarantee is claimed.
