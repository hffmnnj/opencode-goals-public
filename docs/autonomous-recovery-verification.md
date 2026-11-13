# Autonomous recovery verification

Private isolated acceptance ran first with no live configuration, dist or server actions; all hosts were private loopback instances with pinned V2 2.0.25. Phase 1 independent full verification passed, and the exact verified candidate was natively activated through a watched update without restart (see below). Independent live Phase 2 acceptance later passed as a timestamped snapshot. This record is complete within that stated coverage; it is not an exhaustive all-features certification (see limitations).

## Cancellation proof semantics (current)

HTTP 204, inbox pre-presence and inbox post-absence are not proof of non-delivery. Proof is the post-commit native `session.inbox.cancelled` event for the exact session ID and inbox ID, or exact delivered context (a user/synthetic message carrying that ID). If the event is lost and the context is missing, uncertainty is retained (waiting) — never auto-retried or refunded. Pinned native source confirms that the bus commits the conditional DELETE transaction and then notifies after commit, while the HTTP layer swallows conflict/no-op as 204. Source passages were independently reopened at pinned commit `b44eea9e204024db2b480a136ece29d790d5f593`:

- [HTTP cancellation handler](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/server/src/handlers/session.ts): conflicts become an idempotent 204.
- [Inbox projection](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session/inbox.ts): cancellation and delivery compete for the same row; a losing projection aborts.
- [Bus transaction and publication](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/bus.ts): projectors run inside the transaction; notification follows successful commit.

The delayed-cancellation case uses a fixture-only facade to suppress the first owned prompt's wake and buffer a real committed event. It does not manufacture the event, mutate stored state or replace native enqueue/cancellation. Separate preflight checks exercise the normal production wake path.

## Actually run (private)

```sh
bun run typecheck
bun test tests/context.test.ts
python3 scripts/native-recovery.py --case all
python3 scripts/native-background.py --kind both
GOALS_WATCHER_TEST=1 python3 scripts/native-lifecycle.py
python3 scripts/native-preflight.py --goals
python3 scripts/native-preflight.py --goals --command
python3 scripts/native-preflight.py --goals --resume-command
```

Retained private results covered:

- Recovery: active_defer 1/1/2 terminals, no_progress 3/3/4, restart 1/1/2, and delayed_cancel with the old held intent replaced by one new ID, usage 1→2 with no refund, and one terminal.
- Background: shell and child each with continue 1/1, pause 0/0 and user 1/1.
- Disposal: separate shell and child cases passed.
- Lifecycle with watcher: 18 checks, 12 RPCs, automation off.
- Preflight, explicit create and explicit resume command scenarios passed.

- Coordinator full suite: **225 passed, 0 failed, 1,513 assertions** across seven files.
- Coordinator focused runtime/core/command/bridge rerun: **200 passed, 0 failed, 1,226 assertions**.
- Independent bounded cancellation-proof recheck: all three focused selections passed (22, 22 and 16 tests); no activation claim.
- `bun run typecheck` exit 0; context suite 8 pass.

## Concurrent changes and activation preparation

During isolated work, another authorized session activated the reviewed background-only bundle using a canonical root import with a SHA-256 revision query, and the live configuration acquired unrelated plugin changes. That installed baseline, its activation evidence and the current configuration were preserved. The older initial configuration backup was not restored.

A fresh isolated loader proof passed. It observed one fresh generation under the same private process; that host was stopped and reaped. Live activation reused the existing audited hot-activation helper, not a restart or live-location reload.

## Activation (done, watched, no restart)

- The installed candidate had a canonical root shim revision matching the installed digest.
- Native watched activation emitted `plugin.updated` with eight corroborated own-source loads.
- Foreground and managed processes kept their original start times; all 12 configuration/authentication hashes were unchanged; an unrelated concurrent plugin change was preserved.
- The private activation artifact was retained.

## Phase 1 full verification (done, preactivation)

- Independent report retained privately.
- `bun run typecheck` exit 0; `bun test` 225 passed, 0 failed, 1,513 assertions across seven files; private build parity was byte-for-byte (hash and size).
- Native cases: 4 recovery (active_defer/no_progress/restart/delayed_cancel), 6 background (shell/child continue/pause/user), 2 disposals, 12 RPCs with 18 lifecycle checks, 3 preflights, and child-inventory boundaries (1 and 128 accepted; 129 rejected). Named regression faults failed at their intended behavioral assertions, then unmodified cases passed.
- Two known out-of-scope historical defects remained (see the Phase 1 report and [feature verification](feature-verification.md)); Phase 1 coverage limits applied.

## Phase 2 live acceptance (done, timestamped snapshot)

- Independent report retained privately, observed through a fixed timestamp. Verdict: PASS for the assigned final-live segment.
- The latest enumerated locations were all foreground-owned, active canonical `opencode-goals`, all 3 commands, unrelated concurrent plugin active, legacy absent; 12 Code Mode-only `tools.goals` paths verified.
- Stability limitation (transparent): during Phase 2 the enumerated set shrank between observations and owner-file bytes changed; the extra stability assertions failed and are retained as failed, not passing. One bounded reconciliation inspected the latest set successfully. Cause is unknown; immutable lock bytes and location-set stability are not certified.
- Not exercised live in Phase 2: fresh installed method execution, automatic live recovery, production model calls, allowance persistence, managed-server catalog, permissions/forms, compaction, exhaustive interleavings and soak. The coordinator-reported post-activation `goals.get` success was not treated as independent evidence. Local typecheck plus 225 tests, 0 fail, 1,513 assertions were rerun before continuation.

## Standing limitations (still true after activation)

- Selected source, tests, scripts and documentation were integrated into the installed project after baseline comparisons; the installed candidate is that integrated change. No production build command wrote the live dist outside the authorized watched activation.
- Production bundle install stays coordinator-approved; a preserved baseline comparison is required. Source bundle backups never roll back persisted usage. Older bundles may reject the new internal stop metadata: never blindly downgrade runtime or restore an older state snapshot over advanced usage.
