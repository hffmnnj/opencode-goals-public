# Runtime disposal verification

Status: **local repair verified; staged only, not activated.** Live activation and restart were explicitly prohibited for this work. No live reload, service restart, bundle replacement, owner-file change or goal-store edit was performed.

## Diagnosis

- `src/runtime.ts` `alive()` throws `GoalError("disposed", "Goal runtime is disposed")`; `owned()` calls `alive()` first, and `observed()` calls `owned()`, so a stale disposed `context()` throw matches the reported `alive -> owned -> observed -> context` drain fragment.
- `src/index.ts` wires `context` and `compaction` hooks to `active.context(...)` and `prompt` to `active.guardPrompt(...)`; a throw inside a stale hook therefore surfaces in the host drain path.
- Original `call()` rethrew code `disposed`; the corrected public boundary returns the existing structured failure. Core `manage()` remains strict.
- Host log errors reported `Failed to drain Session` with `GoalError: Goal runtime is disposed`, through `alive -> owned -> observed -> context -> SessionModelRequest.prepare`. The initiating teardown was not fully attributed. Host was V2 `2.0.32`.

## Red/green regression evidence

- The initial 11 `disposed_*` tests returned **2 pass, 9 fail** on original source. An additional late prompt/store-read race brought the final set to 12 tests.
- An independent rerun copied source and tests into a scratch directory, replaced only the scratch runtime with the backed-up original, and ran `bun test --cwd <scratch> tests/runtime.test.ts -t 'disposed_'`: **2 pass, 10 fail**, exit 1. These are meaningful disposed exceptions in `context`, `compaction`, host-session-read and store-read races, ordinary `prompt` and owner race, public `call`, and captured tool and RPC paths.
- Passing on unchanged source (already contract-conformant): strict `manage` throws `GoalError("disposed")`; Goals-tagged admission still rejects.
- The legacy captured-executor assertion now checks a schema-valid structured disposed result, serialization, unchanged storage and released ownership.
- Fresh corrected-source `bun test tests/runtime.test.ts -t 'disposed_'`: **12 pass, 0 fail**, 62 assertions.

## Local acceptance

1. [x] Disposed context/compaction returns static policy and an unavailable notice, not stored task text; original disposal fences remain intact.
2. [x] Ordinary prompt yields on disposal; Goals-tagged admissions still reject.
3. [x] Public calls/tools/RPC return structured `disposed`; core management rejects.
4. [x] No automatic recreation, retry, owner acquisition, replay or state reset.
5. [x] Coordinator and independent reviewer ran `bun run typecheck` and `bun test`: **275 pass, 0 fail, 1,858 assertions across nine files**.
6. [x] Staged build and independent rebuild were byte-identical.
7. [x] Private native 2.0.32 lifecycle/watcher harness passed **21 checks** and all twelve RPC methods.
8. [ ] Live activation: **not authorized; deliberately deferred**.

An independent report found no blocking local code defect. In-flight callbacks can have changed in-memory bookkeeping before disposal; this is not rolled back. Already started writes may settle under the existing service contract. Tests establish no new durable writes or admissions on the exercised disposed paths, not rollback.

Post-review test-only follow-through tightened the tagged-admission assertion from generic rejection to exact `code: "disposed"`. Typecheck and the full suite were rerun afterward: 275 pass, 0 fail, 1,858 assertions. Production source and both staged/live bundle hashes were unchanged by this assertion improvement.

## Coverage boundary

- Source changes are confined to `src/runtime.ts`; tests are in `tests/runtime.test.ts`. Live `dist/index.js` and root `index.ts` were unchanged.
- A staging directory and a private activation backup were retained outside the project.
- Read-only live inventory observed Goals `failed/live_owner` in the affected location after reload. No lock file was altered, and recovery is not claimed.
- The project was not a Git checkout; no repository was initialized or published.
- Log review showed duplicate control resumes of the same child sessions and interrupted parent steps. Child tools completing does not establish child-session success (`outcome` was null). The initiating parent interrupt is unproven. No native cancellation fix or live child recovery is claimed; do not repeat stop/resume calls on a running child or infer child failure from an interrupted parent handle.
- The prior [goals-only verification](goals-only-verification.md) PASS remains historical evidence for its own scope only and is not reused as disposal acceptance evidence.
