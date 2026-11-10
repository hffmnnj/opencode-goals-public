# Acceptance matrix

Implementation and acceptance are separate. Each row must be tied to an actual check before claiming installation complete.

| Contract | Realistic fault to reject | Check boundary |
| --- | --- | --- |
| Agent-first creation | Legacy explicit-user-request check survives | Native tool invocation and injected policy |
| Code Mode-only exposure | Goal tools remain direct-only, disappear from discovery or lose calling identity | Exact 12-path native search, execute lifecycle, absence of direct goals_* on model requests, real-runtime context/abort/spoofing checks |
| Session ownership | Tool input redirects another session's goal | Tool executor derives session from context |
| Durable state | Restart silently loses progress | Service reload using a persistent store |
| One current goal | Parallel creates overwrite each other | Concurrent public service calls |
| Revision protection | Stale plan edit discards a completed task | Revision conflict and retained original state |
| Evidence-based completion | Empty evidence or unfinished plan can complete | Public lifecycle operation |
| Plan continuity | Plan replacement drops completed work silently | Public plan update with conflicting revision/content |
| Incremental append | Appending new steps replaces old work, duplicates IDs or exceeds total capacity | Public append with preserved completed/evidenced steps, conflicts and 64-step boundary |
| Stop wins | Delayed admission occurs after pause/cancel | Controlled admission race |
| Interruption is terminal for automation | Interrupted idle triggers another turn | Runtime event path |
| Failure is not retry permission | Provider failure causes endless resumes | Runtime event path |
| No duplicate continuation | Repeated idle event admits twice | Same idle identity delivered twice |
| User priority | Automation queues ahead of pending user input | Runtime plus inbox fixture |
| Restricted agents | Plan/explore session starts autonomous execution | Actual permission-aware policy gate |
| Finite budgets | Zero/negative/unbounded options evade limits | Validation and runtime boundary checks |
| Observed usage | Existing session usage immediately exhausts new goal | Goal baseline plus cumulative session fixture |
| Restart ambiguity | Persisted pending intent is blindly replayed | New runtime over same store |
| Passive command output | `/goal status` starts a model call | Actual command and V2 inbox/log inspection |
| Context retention | Compaction drops objective and acceptance criteria | Context/compaction hook integration |
| Permission preservation | Goal mode auto-approves shell/edit requests | Independent source review and actual API setup |
| V2 compatibility | Adapter compiles against unrelated/V1 package | Pinned package types and actual V2 plugin load |
| Explicit server binding | Another process sharing configuration acquires the configured server's lock | Delayed identity verification before real ownership filesystem access |
| Safe replacement | Both plugins keep injecting competing policies | Live plugin list and command/tool registration |

## Failure and recovery cases

Require behavior-focused checks for storage write failure, stale lifecycle events targeting a replacement, pause racing admission, closed-goal admission ambiguity, eviction-independent no-progress deduplication and disposal of captured executors. A safety hold must survive goal cancellation/replacement. Recovery may be agent-requested, but only the adapter can grant it after inspecting actual same-server state; caller-supplied authorization flags are never accepted.

At least one named production fault should be rejected by a focused behavioral assertion in an isolated copy, followed by a restored green check. Green tests or source-string inspection alone do not establish runtime compatibility.

## End-to-end smoke design

Use a uniquely titled test session in an isolated V2 instance first. Exercise native command/RPC lifecycle without a model; verify durable status, plan/checkpoint, stale revision rejection, completion evidence, cancellation and history. Exercise real native model/tool execution and idle continuation through a deterministic local protocol fixture, clearly distinguished from a real model's judgment. A small live-provider journey is optional when useful. Do not remove user sessions or disable existing permission rules for smoke testing.

Preserve test sessions rather than destructively deleting session trees; archive only where the pinned host exposes a supported operation. Record exact instance, package/version and check output in a final verification report. Native V2 load is necessary even when a fake adapter suite is green.
