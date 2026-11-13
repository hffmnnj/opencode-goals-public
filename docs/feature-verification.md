# Goal feature verification — 2026-10-14

Status: verification completed with findings. Core native journeys passed, but three reproduced edge-case defects remained unfixed. This is not an all-features-clean certification. It is a fresh follow-up after installation, not a restatement of earlier acceptance results.

## Fresh results

| Feature / boundary | Result | Evidence |
| --- | --- | --- |
| Local types, behavior tests and build | Passed | Full local check: 143 tests, 0 failed, 965 assertions; strict TypeScript and build passed |
| Native agent creation, checkpoint, automatic continuation, evidence and completion | Passed | Native preflight on a real V2 2.0.25 host; six scripted provider requests, two successful executions |
| Explicit `/goal create` guarded start | Passed | Automatic continuation disabled; four requests, one successful execution |
| Explicit `/resume_goal` guarded start | Passed | Automatic continuation disabled; four requests, one successful execution |
| Successful execution of all 12 management operations | Passed through real-host RPC | Extended lifecycle harness observed successful get/create/revise/plan/evidence/checkpoint/complete/block/pause/cancel/resume/history; tools and RPC share the service, but this is not a claim that every tool alias was independently driven by a model |
| Native append and invalid-update state preservation | Passed | New step only, retained completed-step evidence, compact summary; duplicate/stale/late-objective edits refused without changing revision or retained work |
| Restart/recovery and watched reload | Passed | Same goal, plan and evidence retained; active automation paused without replay; reconciled resume, archive, history and cooperative watcher replacement |
| Passive command variants and aliases | Passed | Empty/status/help/history/unknown/invalid-create/invalid-resume, pause alias, pause/cancel/clear; empty transcript, tagged passive inbox and no model wake; successful create/resume covered separately |
| Runtime safety, budgets and context coverage | Audited; defects and gaps below | Independent rerun: 125 tests / 889 assertions on core/runtime/context/commands; the full local run includes bridge/ownership/startup tests |
| Packed runtime | Passed fresh native rerun | Independent package's source and built runtime still matched current source and build; six fixture requests, two successful native executions |
| Captured tools across reload | Expected stale rejection reproduced; fresh request succeeds | Held request across an actual watcher replacement received a disposed error; a new model request in the same session succeeded |
| Installed runtime and legacy removal | Partial; one deferred location | Read-only live inspection: replacement active with all three commands in all but one loaded location; legacy absent everywhere |

The native provider is a deterministic local protocol fixture. These results verify the actual host, tool execution and scheduling path, not an external model's judgment.

## Reproduced findings — not fixed in this verification request

Historical results below are preserved. The ambiguous-start wording finding (1) was later addressed; durable ceiling-read tightening (2) and auxiliary-agent fallback (3) remain out of scope for autonomous recovery.

### 1. Start failure notice contradicts ambiguous delivery

`src/commands.ts:301–320` claims “No model turn was started” for every start exception. `src/runtime.ts:355–379` correctly retains a charged ambiguous reservation when native submission may already have delivered work. The unconditional command sentence is therefore unsafe reporting.

The issue was reproduced through the real command adapter, runtime and service with an owned native-I/O fake that records delivery and then loses the acknowledgment. One admission was delivered, the goal paused as `ambiguous`, one turn stayed charged, but the notice still denied any turn started. A positive control delivered one admission successfully with no competing notice. This is an injected owned-boundary fault, not a real-host transport failure.

Follow-up: uncertainty-safe wording and a command/runtime regression case, without weakening runtime reconciliation.

### 2. Trusted reload tightening is not durable after service-only reads

`src/service.ts:189–192` computes lower goal/session limits in the loaded snapshot, but `GoalService.get()` does not persist them. Six independently reproduced cases show goal and session turn/time/token ceilings tightening on read, then returning to their original higher values after another reload with higher configuration. Usage remained exactly one turn / three seconds / eleven tokens. A positive control followed the tight read with `observeUsage()`, which persisted the lower limit correctly.

**Boundary qualification:** normal `GoalRuntime.observed()` follows its read with `observeUsage()`, so normal tools and RPC calls mask this service-level defect. No live tool/RPC budget bypass was demonstrated. The stronger durable-tightening contract is nevertheless not upheld at the public service boundary.

Reproduction: the retained isolated script explicitly records six violations; exit zero means the reproduction and positive controls behaved as expected, not that the budget contract passed.

### 3. Auxiliary context can overwrite the fallback primary agent

`src/runtime.ts:128–130` stores every supplied context agent into `lastAgent`, including `context(..., "compaction", false)`. With no session or default agent, a previously observed primary `build` context normally permits resume. Inserting auxiliary compaction context changes that fallback to restricted `compaction` and causes `execution_restricted` instead. The same scratch reproduction confirmed both the successful control and this false denial.

**Boundary qualification:** the actual pinned host's compaction-hook agent identity has not been established. This is a conditional runtime-boundary defect, not a demonstrated native compaction incident or privilege escalation. Follow-up should keep primary-agent evidence separate from auxiliary contexts.

## Disposed executor investigation and direct probe

A conversation observed a disposed error on `goals_get`, then successful `goals_history` and `goals_get`, successful creation of a labeled bookkeeping-only test goal, and another disposed error on revise. These failures must not be hidden by healthy inventory or successful execution outcomes.

Independent investigation and a coordinator rerun held a native model request across an actual plugin replacement. The old captured tool rejected with the exact disposed error; RPCs remained healthy; a fresh model request in the **same session** successfully executed `goals_get`. Pinned host tool snapshots capture executors per request, and plugin cleanup intentionally fences old runtimes. Keep this guard; do not forward stale mutations into a replacement runtime. The exact historical reload timing of the conversation's failures was not correlated.

The direct test goal hit its configured observed-token budget and remained paused; no limit was raised, replenished or bypassed. It was then cancelled with its history and consumed usage preserved, not falsely completed. No pre-existing goal was overwritten. All-operation lifecycle success is established by the isolated real-host RPC scenario instead of pretending that this direct probe succeeded end to end.

## Independent coverage audit and remaining acceptance gaps

Existing behavior tests cover strict schemas, session ownership, revision conflicts, evidence-gated completion, completed/evidenced-step retention, duplicate/capacity append checks, finite budgets and no refunds, controlled reservation/admission races, exact-owned withdrawal, user/form/permission priority, restricted agents, failed/interrupted outcomes, no-progress accounting, stream rejection, storage faults, corruption, restart ambiguity and ownership/disposal. These safety cases are mostly controlled in-process boundaries, not separate real-host fault injections.

Specific remaining gaps:

- Actual native compaction-hook retention and its agent identity, including leaving `event.result` untouched.
- Native-host pending-form/permission priority, restricted/fork/subagent eligibility, failed/interrupted execution, budget exhaustion and no-progress stopping; fixture-level tests are not native incident evidence.
- Move events, queue/provisional-run overload limits and graceful unexpected event-stream EOF.
- Disposal during an in-flight native admission, and passive-notice delivery/cancellation/failure/capacity branches.
- New permanent regressions for the three findings above. No production behavior was changed just to make the verification green.

Only the shipped lifecycle acceptance harness was extended; production TypeScript, trusted configuration and server lifecycle were not changed. Scratch artifacts used unique preserved directories; no recursive cleanup was performed during this follow-up.

## Live boundary

One managed location remained blocked by live ownership in another process, and its foreground commands were unavailable. This was an operational blocker, not a passed activation check. The operator's explicit decision to leave that server's work running was preserved. No configuration, existing user goals, pending forms/inputs, ownership files or servers were changed by the read-only live inspection.

## Known contract limitations

- Status/help/stop command output is queued passive context, not an immediately delivered transcript reply, on the pinned V2 host.
- Restart/reload pauses persisted active automation; recovery requires adapter reconciliation, not blind replay.
- V2 lacks atomic idle-only admission. The plugin cannot promise exactly-once execution or instantaneous cancellation of already delivered work.
- Token limits use observed native session usage, not a provider-enforced cap or independent descendant billing ledger.
