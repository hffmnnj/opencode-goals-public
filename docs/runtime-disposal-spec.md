# Runtime disposal repair spec

## Objective

Implement fail-closed behavior when the Goals `GoalRuntime` has been disposed,
so stale session hooks do not throw into the host drain path and do not
touch goal state. This covers the reported `Goal runtime is disposed` fault
and keeps the separate subagent-interruption investigation distinct from the
verified local repair. Live activation is explicitly prohibited by the user.

## Actual evidence (observed, not inferred)

- Known host log (verbatim stack fragment): `Failed to drain Session stack
  alive -> owned -> observed -> context -> SessionModelRequest.prepare`,
  with adjacent `watcher stopped` lines.
- Active host at report time: V2 `2.0.32`.
- Current source path that produces the throw: `src/runtime.ts`
  `alive()` (`throw new GoalError("disposed", "Goal runtime is disposed")`),
  reached via `owned()` -> `observed()` -> `context()`; `src/index.ts`
  registers that `context` result directly into `context` and `compaction`
  hooks.
- Original `call()` rethrew `disposed` strictly (runtime.ts line ~291);
  all other errors become structured `{ ok: false, error }`.
- Red baseline on unchanged production source (original-code evidence):
  test minion added 11 `disposed_*` cases to `tests/runtime.test.ts`;
  `bun test tests/runtime.test.ts -t 'disposed_'` returned 2 pass, 9 fail.
  The 9 failures are the intended red: disposed exceptions in `context`,
  `compaction`, host-session-read and store-read races, ordinary `prompt`
  and owner race, public `call`, and captured tool and RPC paths. Strict
  `manage` and Goals-tagged admission cases passed on unchanged source.
  The existing legacy executor-rejection test passed and is now being
  aligned to the decided structured-error contract by the test-only writer.
- The local fix is implemented in `src/runtime.ts` and tested with twelve
  disposal regressions and the full plugin suite. Exact red/green, build and
  independent-review evidence is in [verification](runtime-disposal-verification.md).
  The live bundle and root shim remain unchanged.

## Scope and constraints

- Files in scope: `src/runtime.ts` (disposal guards),
  `src/index.ts` (hook wiring only if needed to pass through the static
  fallback), focused disposal tests, and these two documents.
- This is repair-local documentation in the existing non-Git
  `opencode-goals` project. Do not initialize or publish a repository.
- Do not perform live API calls, builds, commits, restarts, or service
  lifecycle changes as part of this documentation task.
- Preserve existing ownership, authentication, version-guard, and
  fail-closed scheduling behavior. No unrelated cleanup.

## Decided contract

1. Stale disposed `context` / `compaction` returns static `POLICY` plus a
   short reload/unavailable notice, with no stored task text. It must not
   perform further owner/storage/bridge/host I/O; must not publish
   state, schedule recovery, or mutate epochs, runs, recoveries,
   withdrawals, or notices.
2. Foreign/ordinary `prompt` callbacks yield (return without acting) on
   disposal: no further durable writes or admissions. In-flight callbacks can
   have changed in-memory bookkeeping before disposal; no rollback is promised.
3. Goals-tagged admissions still reject on disposal: stale disposed
   admissions throw `GoalError("disposed", ...)` (or the existing
   `invalid_transition` stale-admission refusal where the disposal check
   fires first), so no disposed admission can pass the guard.
4. Public `runtime.call` returns a structured disposed error
   (`{ ok: false, error: { code: "disposed", ... } }`) instead of
   rethrowing, while core `manage` stays strict and throws
   `GoalError("disposed", ...)`.
5. No automatic runtime recreation, no retry, no goal state changes, and
   no service restart on the disposed path. Reload of the runtime remains
   an explicit host/plugin lifecycle action.

## Acceptance checks

1. Disposed `context` and `compaction` return `POLICY` plus
   reload/unavailable notice, with zero stored task text and zero state
   mutation on the exercised disposed paths; already-started writes may settle.
2. Disposed foreign/ordinary `prompt` returns without state mutation;
   disposed Goals-tagged admission rejects.
3. Disposed `call` returns structured `disposed` error; disposed `manage`
   throws `GoalError` with code `disposed`.
4. Focused disposal tests, type checking, relevant suite, and fresh build
   pass (verified in the linked evidence).
5. Live activation remains deliberately unperformed under the explicit instruction not to activate or restart live. Do not treat staging as live deployment.

## Out of scope

- Exact-session correlation confirms duplicate child control calls and aborted
  parent steps, but not the initiating interruption signal. A later reload
  observation must not be equated with historical proof. No native core
  cancellation change or child recovery is included.
- Broad hook refactors, retry/recreation logic, or changes to the twelve
  lifecycle operations.
