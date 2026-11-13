# Background continuation roadmap

**Autonomous-recovery follow-up:** the background-only activation evidence below is preserved as history. The integrated follow-up adds idle-boundary recovery, keeps normal follow-ups active, and requires exact committed cancellation or delivered-context proof. Its [verification record](autonomous-recovery-verification.md) supersedes the older instruction to request manual recovery after every reload. Final combined activation is recorded there, separately from this historical rollout.

- Done: inspect runtime, bridge, pinned public types and native tool implementation.
- Done: diagnose parent-loop idle versus background-resource lifetime.
- Done: bounded same-server inventory and event-driven deferred scheduling.
- Done: behavioral unit regressions, including suppression without reservations, correlated completion, duplicate/racing events, superseding runs, pause/block/cancel/user input/disposal, and malformed/foreign/capacity safety state.
- Done: isolated real 2.0.25 background shell and subagent critical paths. FIFO and provider-event gates hold work beyond parent success; native event/runtime drain barriers synchronize assertions without sleeps.
- Done: the original missing-background-check fault is red for both shell and subagent at `Background work was charged before completion`, then green on unmodified source.
- Done: final typecheck, 167 tests (0 failures), production build, native foreground preflight, six native continue/pause/user cases and two disposal cases.
- Done: coordinator-authorized hot activation of the reviewed bundle and revised watched root entrypoint. Native loader freshness was proved privately first; live watcher, catalog and load-log evidence and an unchanged process were retained. No server restart, location reload, live configuration edit or forced goal resume.

## Verification evidence (2026-10-14)

Commands, run from the project root:

```sh
bun run typecheck
bun test
bun build ./src/index.ts --outdir <staging>/dist --target bun --external '@opencode/*' --external zod
python3 scripts/native-background.py --kind shell --original-fault
python3 scripts/native-background.py --kind child --original-fault
python3 scripts/native-background.py --kind both
python3 scripts/native-background.py --kind shell --dispose
python3 scripts/native-background.py --kind child --dispose
```

The two `--original-fault` commands intentionally exit 1 at the behavioral assertion, not at compilation or setup. All other listed commands exit 0. Six-case green, disposal, original-fault, production-bundle preflight and independent fresh-run artifacts were retained outside the project.

All background harness hosts isolate HOME, XDG paths, database, configuration and workspace, scrub credentials/proxies/OpenCode overrides, and use only a loopback scripted model. Private hosts are stopped and reaped; the foreground host is not stopped or restarted. Disposed runtime hooks can reject the native completion's new model turn, so disposal assertions synchronize on native terminal events and read persisted allowance directly through the private fixture, not assistant text.

## Activation and future updates

The live root entrypoint imports canonical `dist/index.js` with a SHA-256 revision query; source edits are not activation.

For future authorized updates, preserve both previous files, install the reviewed bundle atomically, and refresh the root import query to the new bundle SHA-256. Keep the import pointed at canonical `./dist/index.js`, not a version-specific copy that subsequent builds would leave stale. A build to `dist` alone is not the verified activation procedure. Confirm native `plugin.updated`, an exact-source native load-log entry, active catalog state and an unchanged foreground process. The reusable activation block retains exact backups and refuses blind reinstall into an existing evidence directory. This requires no server restart, location reload or configuration rewrite.

Native plugin reload fences old runtimes and intentionally pauses persisted automation for restart recovery. No goals were resumed, canceled or reconciled by this activation. Any later recovery requires separate appropriate user action; do not replay an old deferred boundary.

Live watcher acceptance is recorded above. Live external-model background behavior was not exercised; functional acceptance remains the isolated native shell/subagent cases and behavioral unit regressions. Detached OS processes and asynchronous third-party tools without native owned resource/lifecycle records are outside the observable API contract, not claimed as fixed.

## Independent-review follow-up

- Done: a real isolated 2.0.25 inventory probe created 129 dormant children without prompting any session. Exact one-child/final-cursor, 128-child and 129-child responses, generated IDs and real source-bridge results were retained. The one-child next page was empty even though the preceding final page had a nonempty `next` boundary. With 129 children, native requests with limits 1, 50, 128 and 129 returned exactly those cardinalities, not a silent default or cap. The real `LoopbackBridge.background` accepted complete inventories at 1 and 128 and failed closed with `shape` at 129. All returned IDs matched the exact parent. Reproduce with `python3 scripts/native-background-inventory.py`.
- Done: synchronized shell/child regressions introduce owned work only once reservation persistence is reached. Strict pre-submission eligibility rejects both: zero native prompt attempts or nudges, one retained goal/session charge, paused state, exact never-submitted intent retired, duplicate terminal events produce neither retries nor repeated charges, and explicit recovery resumes without replay or refund. This is the existing anti-replay accounting model, not an attempt to atomically combine separate public APIs.
- Done: assessed changed-code retention. Deferred runs share the existing 128-run cap; snapshots are bounded to 1,000 shell and 128 child IDs and replace previous data; in-flight completion sets cap at 128 distinct keys and fail closed on the 129th. A focused boundary regression exercises this last guard. No new global resource or session registry was added.
- Separate follow-up, not implemented here: legacy uncapped `known`, `lastStarted`, `epochs`, `depths` and related session-lifetime maps can retain keys across many historical sessions. This predates background deferral; inventory-discovered IDs do not enter those maps, and deferred completion rechecks reuse the same parent key. A broader lifecycle-retention policy needs its own requirements rather than an unrelated eviction redesign in this fix.
- Done: runtime and bridge-ownership focused suites passed 68 tests, 472 assertions, zero failures; typecheck passed. This includes two late-arrival regressions and the completion-set capacity boundary.
- Done: bypassing only the late background eligibility gate in a private copy made both late-arrival tests fail at `promptAttempts`: expected 0, received 1. The same tests then passed against unmodified project source. No production code change was needed; this closes evidence for the existing conservative behavior.
- Done: rebuilt only the private reviewed production output with the command above. A second in-memory `Bun.build` compared byte-for-byte equal to the staged file. Production behavior did not change, so no exhaustive native rerun was necessary; a fresh independent six-case artifact was also retained.

### Correct accounting promise

No automatic-turn reservation or charge when busy work is observed **before** reservation. If work starts after an empty inventory during reservation, strict pre-submission checks suppress delivery but preserve the already-consumed single charge. No refund, automatic retry, or atomic inventory/reservation/prompt claim.
