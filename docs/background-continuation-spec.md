# Background-aware goal continuation

## Goal and scope

Defer automatic continuation while native background shells owned by the goal
session or its active child sessions remain unfinished. Reconsider on real native
completion, without synthetic wait prompts, timer delays, or polling. Busy work
observed before reservation incurs no automatic-turn reservation or charge.
Preserve existing admission fences, user priority, budgets, ownership and crash recovery.
Local source-only change: no Git initialization, production reload or dist write.

## Diagnosis and pinned API evidence

`session.execution.succeeded` and plugin `session.wait` describe the agent loop,
not native jobs. The 2.0.25 shell tool creates shells with `metadata.sessionID`;
the shell list exposes `id`, `status`, and that metadata. `shell.exited` carries
the exact shell ID and terminal status. Native subagents create/reuse sessions
whose `parentID` is the calling session; session list accepts `parentID`, and
session active reports running loops. A completed tool call can still return
`status: running`, so tool-call completion is never background completion.

Native integration additionally confirmed that 2.0.25 returns a nonempty `next`
boundary cursor even for a one-child final page. Completeness is checked by
requesting 129 records and accepting at most 128, not by cursor presence. A
new child with no terminal outcome is unfinished even before it appears in the
active-loop map. The internal Job service is not a public plugin API; the fix
uses public resource inventories and exact native resource terminal events.

## Design

Extend the same-server bridge's fail-closed inspection with bounded, validated
shell and child-session inventories. Only exact owned resources block admission;
unrelated running sessions do not. Retain a successful parent run while these
resources are busy, without reserving a dispatch. Relevant terminal events cause
one serialized recheck of native state. Coalesce duplicate events and handle an
event arriving during an inspection. All existing run/epoch/lifecycle fences
remain authoritative. No deferred boundary is persisted or replayed after crash.

### Admission atomicity boundary

The public native inventory, durable reservation, and prompt APIs are separate
operations, not a shared transaction. If an inventory is empty, then new owned
work starts during reservation persistence, the strict pre-submission eligibility
check rejects the continuation. There are zero native prompt attempts or nudges
in that race, but the already-reserved single charge remains consumed. The
runtime pauses and safely retires that exact never-submitted intent; completion
events do not retry it or accumulate more charges. Explicit reconciliation/resume
can proceed without replaying the intent or refunding the consumed allowance.

The zero-charge guarantee applies to busy work seen before reservation, not to
retroactive refunds for late arrivals. A still-later arrival after the final
check is likewise not atomically excluded by the public API. Existing native
admission/lifecycle guards remain in force; no claim of transactional inventory,
reservation and external prompt delivery is made.

### Changed-code retention bounds

At most 128 native runs are retained, including new deferred runs. Each deferred
background snapshot has at most 1,000 shell IDs and 128 direct child IDs. Each
in-flight completion set stores at most 128 distinct keys; the next distinct key
fails observation closed instead of growing the set. Completion sets are cleared
after checks, deferred data is replaced rather than accumulated, and pause,
supersession and disposal fence pending work. There is no completed-job history,
per-job timer, or polling queue added by this change.

Legacy session-lifetime maps such as `known`, `lastStarted`, and zero-valued
`depths` entries remain separately uncapped. Background inventory does not add
its discovered child/shell IDs to those maps, and completion-triggered rechecks
reuse an already-known parent key. Their preexisting cross-session retention is
not represented as fixed by these changed-code bounds.

The guard covers native shell jobs directly owned by the session and direct
native child sessions, not detached OS processes or third-party asynchronous
work with no native ownership/lifecycle record. Such integrations need their own
authoritative host boundary; assistant text and arbitrary global activity are
never used as substitutes.

## Acceptance checks

- Running owned shell and child seen before reservation suppress prompt and auto-turn reservation.
- Owned work arriving during reservation suppresses native submission, retains
  exactly the one consumed charge, retires the unsubmitted intent, and never spins.
- Real completion allows one fresh guarded continuation; duplicates cannot spin.
- Unrelated jobs/sessions do not block or wake the parent.
- Missing/malformed inventories fail closed; capacity exhaustion fails closed.
- Pause, block, cancel, user input, new execution and disposal invalidate deferral.
- Normal foreground continuation, existing policy/budget/recovery tests pass.
- Behavioral regression fails on the original bug and passes with the fix.
- Isolated pinned-host native shell/subagent critical path is exercised with
  controlled synchronization; production config, server and dist are untouched.
