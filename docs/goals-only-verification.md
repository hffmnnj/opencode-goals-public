# Goals-only verification

Status: **implemented, activated, and independently verified — PASS.** This checklist tracks the
[goals-only restoration](goals-only-spec.md): remove the board-only
`goals.snapshot` RPC, its schemas, `service.peek`, and
`runtime.passiveSnapshot` from `opencode-goals`, while preserving
standalone native Goals (twelve lifecycle operations, typed `GoalsRPC`,
slash commands, persistence, usage accounting, continuation safety). The
separate Workboard/state-manager application is unchanged. The coordinator
owns the roadmap and fills exact verification/activation evidence.

## Preserved surface (must remain)

- Twelve native Goals lifecycle operations, discoverable under the `goals`
  namespace inside `execute`, with no separate direct `goals_*` model tools.
- Typed `GoalsRPC` (id `goals`) for the lifecycle operations only.
- Human slash commands (`/goal`, `/pause_goal`, `/resume_goal`) backed by
  the same goal service and validated state transitions.
- Persistence, usage accounting, plans, evidence, commands, continuation
  safeguards, ownership, and server-binding checks.

## Removed surface (must be absent)

- Board-only `goals.snapshot` RPC and its registration.
- Snapshot input/output schemas and DTO types.
- `service.peek` and `runtime.passiveSnapshot` (and their unused support).
- Historical detail remains in [passive workstreams telemetry](passive-workstreams-telemetry.md),
  marked superseded/removed — not current behavior.

## Acceptance checklist

1. [x] Source, registered RPCs, and built runtime expose Goals only:
    twelve lifecycle operations present, board-specific snapshot API absent.
2. [x] Focused behavior tests pass (included in the complete suite below).
3. [x] Type checking passes.
4. [x] Complete relevant plugin test suite passes.
5. [x] Fresh build passes.
6. [x] Active V2 configuration loads the rebuilt local plugin with native
    Goals options only (no unrelated configuration changes, no obsolete
    ceilings).
7. [x] Read-only runtime evidence confirms activation when available
    (no restart, no calls altering goal state); exact tested and untested
    scope recorded.

## Build and source checks

Coordinator ran `bun run typecheck && bun test && bun run build` after integrating
the removal and exact `2.0.32` compatibility changes: **263 pass, 0 fail,
1,793 assertions across nine files**; type checking and build passed.
`@opencode/plugin` and `@opencode/client` both resolve to `2.0.32`; Effect resolves
to `4.0.1`. Bridge and managed-registration checks share one exact-version constant;
unsupported versions still fail before privileged reads or owner/state access.

The replacement contract coverage is `tests/rpc.test.ts`; namespace-isolation
coverage uses the ordinary Goals `get` API instead of removed telemetry. A source
and bundle scan found no removed telemetry symbols, and an import of `GoalsRPC`
advertised exactly the twelve lifecycle methods.

The installed `dist/index.js` SHA-256 and the root shim's matching revision were recorded in the private activation evidence. The root shim references that exact installed revision.

## Isolated native acceptance

Both harnesses used `GOALS_EXPECTED_VERSION=2.0.32` and the actual release
executable, with private XDG/config/data/state/workspace/database paths and
loopback-only fixtures. Each asserted the native `/api/info` version and the
spawned process identity. Child test processes were stopped by their harnesses;
artifacts were preserved.

- `python3 scripts/native-preflight.py --goals`: **passed**, eleven scripted-provider
  calls, two successful native turns. All twelve Code Mode paths discovered,
  with lifecycle work executed through Code Mode; no direct Goals model tools;
  null limits, retained accounting,
  append preservation, stale-revision refusal, continuation and completion passed.
- `GOALS_WATCHER_TEST=1 python3 scripts/native-lifecycle.py`: **passed**, 21 checks
  and all twelve RPC methods observed successfully. Includes evidence/revision
  fencing, persistence/restart no-replay, pause/cancel/block/resume/history,
  passive commands without model wake, and watched plugin reload without owner
  conflict or replay. The removed snapshot method returns native
  `rpc.method_not_found` at the real HTTP boundary.

Isolated preflight, lifecycle and watcher artifacts were retained privately.

The first lifecycle attempt stopped at a test assumption: missing RPC methods
use HTTP **400** with `rpc.method_not_found`, not HTTP 404. The installed protocol
declares `RpcError` as HTTP 400. The test was corrected to assert both that exact
status and error type; the full fresh lifecycle/watcher rerun above passed.
No production guard was weakened to recover from this harness-only failure.

## Activation and preservation

- Restored only the local `opencode-goals` plugin entry in the V2 plugin list,
  with `autoContinue: true`, the configured loopback `api.baseURL`, and
  `allowAgents: ["build"]`. Deprecated limit settings were not restored.
- `/api/plugin` reports `opencode-goals` **active**, loading the rebuilt root
  shim at the current configuration location.
- Native Code Mode `search({ namespace: "goals", limit: 20 })` reports exactly
  twelve paths, zero remaining results, and no pagination.
- `/api/command` exposes `goal`, `pause_goal`, and `resume_goal`.
- `/api/info` remains V2 `2.0.32` with the same process before and after activation;
  the service manager reported the same running process. No server restart was performed.
- Removing only the new Goals entry from current configuration produces a
  structurally identical document to the pre-activation backup (`jq -S` + `cmp`).
  The current configuration hash was recorded privately.
- A private activation backup of the original configuration, root shim and built bundle was retained.

## Independent verification

Read-only full verification returned **PASS**, with no high- or medium-severity
findings. It independently reran type checking, all 263 tests / 1,793 assertions,
a staged build byte-identical to the installed bundle, native preflight, and the
21-check lifecycle/watcher scenario. Coordinator also reopened the fresh native
artifacts and compared the staged bundle against the activated one.

- Independent report and native artifacts were retained privately.
- Independent preflight: eleven provider calls, two successful turns, no event or
  provider errors, catalog, null-limit accounting, and append/stale-revision checks
  all confirmed.
- Independent lifecycle: 21 checks and all twelve lifecycle RPCs confirmed.
- Independent staged bundle: byte-identical to the activated build.

Some older source comments retain `2.0.25` historical observations; these have no
runtime effect and do not widen the exact current `2.0.32` guard. No unrelated
comment cleanup or behavioral follow-up was included.

## Coverage boundary

The separate Workboard/state-manager application is out of scope and unchanged.
No real goal RPC was called, actual goal data manually edited, owner file
reclaimed/deleted, service restarted, or repository initialized/published.
Live evidence is scoped to this observed location/process, not every other loaded
location or server. Specialized historical recovery/background harnesses still
target `2.0.25` and are not counted as `2.0.32` acceptance evidence; current unit
coverage retains those safeguards. Live user-goal automation and managed-service
discovery were not exercised against user state; private native and focused
file/listener tests cover their corresponding boundaries.
