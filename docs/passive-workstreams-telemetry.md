# Passive workstreams telemetry — SUPERSEDED / REMOVED

> **Superseded and removed from the Goals-only contract.** Per
> [goals-only restoration](goals-only-spec.md), the board-only
> `goals.snapshot` RPC, its schemas, `service.peek`, and
> `runtime.passiveSnapshot` are removed from `opencode-goals`; only the
> twelve native Goals lifecycle operations remain. This document is
> preserved below unchanged as historical evidence of the staged
> passive-snapshot candidate. It is not current behavior, not a reactivation
> claim, and not a change to the separate Workboard/state-manager
> application. Current status and pending evidence live in
> [goals-only verification](goals-only-verification.md).

## Goal and scope

Expose one public native RPC, `goals.snapshot({ sessionID })`, for a selected-session
workstreams board. The existing 12 Code Mode operations and all existing RPC
semantics remain unchanged. This is not a tool, scheduler observation, recovery
request, source of authorization, or completion percentage.

Only this checkout's source, tests and documentation may change. Do not overwrite
`dist/index.js` or root `index.ts`, activate/reload a plugin, inspect live goals,
change owners, restart a service, or change global configuration. Stage the bundle
under `<private-path>` for coordinator review.

## Boundary and invariants

- `GoalService.peek` reads only its own plugin storage using
  `sessionStorageKey(this.location, sessionID)` and existing pure stored-state
  validation. It does not enter `serial`/`load`, recover, account, enforce,
  save, populate recovery caches, or project elapsed time. There are no
  spending ceilings to enforce; goal/session `limits` are always null.
- `GoalRuntime.passiveSnapshot` validates a bounded session ID, checks disposal and
  the current runtime owner before and after the asynchronous read, and combines
  `peek` with pure diagnostics. It does not call `owned`/`getSession`, `manage`,
  `observed`, `publishState`, withdrawals, bridge methods, policy, scheduling,
  prompt, notify, wait, usage accounting, or native host methods of any kind.
- The current RPC location is authoritative. Input accepts no location, key,
  path, owner or trusted fields. Stored location/session identity is validated.
  The current exclusive owner is asserted without adopting the persisted owner:
  a previous owner's valid persisted state may be displayed without recovery.
  A session already known to have moved fails closed without changing its fences.
- Disposal, ownership failure, corrupt/mismatched state and storage errors fail
  closed with sanitized enum-only `unavailable` reasons. They are never `none`.
  Absence means no record/current goal in this namespace, not a cross-location
  session lookup or a statement about all other locations.
- Output is strict bounded JSON. No full objective, plan/acceptance/evidence text,
  blocker/detail, checkpoint text, archives/history, prompt/tool arguments,
  transcripts, credentials, owner token or storage location is returned.

## Public contract

`GoalsRPC` remains exported by `opencode-goals/rpc` (`src/rpc.ts`). Input and output
schemas and inferred DTO types live in `src/contracts.ts`. HTTP uses
`POST /api/rpc/goals/snapshot`, body `{ "input": { "sessionID": "ses_..." } }`,
with the native client's authenticated location context. The native HTTP envelope
contains `output`. A separate consumer must use public native RPC over safe
loopback, not cross-plugin storage or same-process runtime imports.

Portable imports (no runtime/service import):

```ts
import { GoalsRPC, PassiveSnapshotSchema, type PassiveSnapshot } from "opencode-goals/rpc";

// Use an already authenticated native HTTP client with the authorized location.
const snapshot: PassiveSnapshot = await client.rpc(GoalsRPC).snapshot({ sessionID });
```

The exact input is `SnapshotInputSchema`, a strict object containing only
`sessionID: /^ses[A-Za-z0-9_-]+$/` (maximum length 160). The exact output is
`PassiveSnapshotSchema`; both schemas and types `SnapshotInput`/`PassiveSnapshot`
are also re-exported from `src/rpc.ts`. `GoalsRPC.methods.snapshot` binds these
validators directly. Runtime registration calls `runtime.passiveSnapshot`, never
the existing operational `runtime.call`/`runtime.manage` path.

The result is discriminated by `availability`:

- `available`: actual current goal ID, goal revision/status/stop-reason enum,
  objective title (at most 160 characters), all four plan status counts, total
  and required remaining, acceptance total and `withReportedEvidence`, retained
  checkpoint count; persisted goal and lifetime-session usage with null limits.
- `none`: no current goal; no invented goal/count/budget values.
- `unavailable`: sanitized reason; no stale or fabricated goal/count/budget values.

All variants include `sessionID`, `observedAt` (Unix milliseconds),
`source: "native_goals_persisted"` and `schemaVersion: 2`. Available also includes
`revision` (durable envelope revision) and `sourceUpdatedAt` (goal content/lifecycle
Unix milliseconds, **not** last accounting write time). `goal.revision` is the
separate content/lifecycle revision. Usage provenance is `persisted_observation`:
autoTurns are charged admissions, activeSeconds are persisted observed seconds,
tokens are normalized cumulative-session deltas, not exact plugin attribution.
Both `budget.goal.limits` and `budget.session.limits` are literally null: the
budget container is retained for integration continuity with usage/units, but
no numeric ceiling, persisted limit or enforced denominator is reported.
Pending work may finish; elapsed time/tokens since
the last durable observation are intentionally absent. `Goal.progress` is an
internal verification-event counter and is not exposed as a percent.

Available/none include only pure runtime diagnostic enums/booleans: autoContinue,
bridge, events, optional recovery, usageAccountingOnly, alreadyDeliveredMayFinish.
These are previously known observations, not fresh bridge verification. Consumers
must label evidence as reported and determine staleness from observation time.
Commands/context/docs show usage without finite denominators.

## Acceptance checks

1. Freshly stored active state, including a previous owner and unrecovered dispatch,
   is displayed without recovery/accounting/reservation. AutoContinue=true,
   ambiguous dispatch and null limits do not change this.
2. Repeated and concurrent snapshots leave storage bytes, service bookkeeping,
   runtime maps/sets/caches and existing pending objects unchanged. Throwing native
   host/bridge fakes prove that even read-side native effects are forbidden.
3. Wrong location/session, corrupt state, absent state/current, current closed
   goals, storage failures, unowned/disposed and in-flight owner/disposal changes
   return the documented result without sensitive error contents or writes.
4. RPC registration routes snapshot directly to passiveSnapshot; schema rejects
   arbitrary location/key/path and invalid IDs. Original 12 tools remain unchanged.
5. Focused tests, typecheck, final relevant full suite and an externally staged
   build pass. Record artifact path/SHA256 and confirm live entrypoint hashes.
6. If an existing safe private native harness can exercise this exact RPC without
   bypassing effect guards, prove the 2.0.25 HTTP boundary there. Otherwise report
   native integration unverified, without accessing the live service.

## Verification checkpoint — SUPERSEDED finite-ceiling history, preserved as evidence

> The v1 `schemaVersion: 1` results below are factual history for the staged
> passive-snapshot candidate. The current contract is `schemaVersion: 2` with
> both `budget` limits null (see above); do not treat persisted numeric limits
> below as current behavior.

Specification recorded before implementation/build. Source implementation and
local verification completed; staged candidate only, not activated.

- `bun test`: **246 pass, 0 fail, 1,661 assertions** across eight files.
- `bun run typecheck`: passed.
- `tests/passive-snapshot.test.ts`: 21 focused cases. Fresh previous-owner active
  state, concurrent repeated reads, exact persisted usage/limits despite lower
  runtime options, ambiguous dispatch, budget boundary, empty plan, pending
  recovery fences in an already-observing runtime, closed goals, missing
  state/current, other namespace, corrupt
  location/session/schema/invariants, read failure without fault-flag poisoning,
  lost owner, known move, disposal and in-read disposal/owner changes are covered.
  Throwing host/bridge boundaries record zero calls; serialized storage bytes,
  cached raw objects and service/runtime bookkeeping remain unchanged.
- Fault detection: an isolated source copy under the staging directory was
  changed to call `get` from `peek`. The fresh-active case failed at the behavioral
  assertion: status changed to paused/restart and content/envelope revision
  advanced. Production source was never mutated for this check.
- External build command: `bun build ./src/index.ts --outfile
  <private-path> --target bun
  --external '@opencode/*' --external zod`. Bundle SHA256:
  `500b3bcbd5cdb48d157682273b1a6fbe9c8defd282b079b6d4db18218349a074`.
- Live `dist/index.js` remains SHA256
  `aa6b6c9b3836bce02348f486d73b686e9439f345f908c64e878ed6874dad5d2a`;
  root `index.ts` remains SHA256
  `53c8cb444b9a897ea0315b219121ea900f49ce32dca290337c9c3ddb628163fb`.
- Native private probe **blocked before execution**: the existing
  `plugin-hot-activate --mode probe` Block declares `effects = "external"`, which
  `.blocks/config.toml` does not allow. No policy change, direct-script bypass,
  live call, native fixture launch, reload, restart, activation or owner change
  was performed. Real 2.0.25 HTTP integration remains **unverified**; registration
  and the pinned portable schemas are covered locally.

Freshness limitation: without forbidden native session reads, snapshot cannot
discover an unobserved session relocation or update live token/time observations.
It reports only the authoritative RPC location's validated persisted namespace,
with an already-known move rejected. Consumers must not infer global absence,
fresh session execution state or independently verified completion from this DTO.
