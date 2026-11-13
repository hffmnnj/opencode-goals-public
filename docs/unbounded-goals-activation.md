# Ceiling-free Goals activation

## Authority and scope

Activation was authorized for the exact reviewed Goals build and workstreams bundle in the current foreground workspace only. After preflight discovered incompatible installed dashboard artifacts and an external-effects policy gate, the user selected a safe path: activate verified dashboard/backend compatibility first, temporarily permit external effects for the activation helper, and restore the policy afterward.

The deployment runner then refused the necessary cross-project paths; no production writes occurred. Its temporary effects policy was restored byte-for-byte. After that check failure was disclosed, the user separately selected direct scoped activation: execute the reviewed deployment helpers directly for these exact artifacts, retaining internal hash, backup, server-identity and atomic-update checks, without changing the effects policy. This is task-specific deployment authority, not a general exemption from runner confinement or permission requests.

This superseded the source-only activation exclusion solely for the verified artifacts and their watched-root/static-loader changes. The disclosed Goals build contained previously staged isolation and telemetry code; the verified foreground legacy namespace, existing usage and safety holds were preserved. No restart or eviction, owner-file deletion, usage reset, manual goal-state edit, unrelated configuration change or Git publication was performed.

## Plan and acceptance

1. Record foreground identity and compatibility baseline, loader proof, exact artifacts and private rollback bytes; revalidate before effects.
2. Complete runner policy/path preflight and restore the policy. Use separately authorized direct deployment, with private fixture tests and independent static-helper review before any production static publication.
3. Safely install verified web static compatibility and the workstreams bundle, then the exact Goals build via a backed-up atomic dist/root watcher update. Retain old hashed web assets for already-open pages. No explicit location reload.
4. Verify `plugin.updated`/load evidence and exact installed bytes in the same foreground process; inspect live Code Mode, null limits, accounting continuity, passive snapshot/board compatibility, configuration and ownership integrity. Legacy explicit stops must remain held. Native state migration is runtime-owned.
5. Conduct independent final activation review and a precise documentation/status update. A bundle backup is not a schema-v2 state downgrade; never roll state backward.

## Observed activation (current foreground workspace only)

Direct scoped activation was executed for the reviewed artifacts. All statements below concern only the observed foreground workspace and the private evidence root, not every other loaded location.

- Static helper review: **PASS**, 8/8 private-fixture checks. Allowlisted index/theme/assets only, API and board entries excluded, old assets retained, index published last, and backup/modes, collision/symlink/traversal/bounds/concurrency cases covered. The TOCTOU limitation is cooperative-only and documented. No live deployment resulted from the fixture run.
- Direct loader proof: **PASS** on a private host, using a canonical-dist SHA-256 query strategy in a private workspace; the host was stopped afterward. `plugin.updated` was observed with two same-process loads and zero model executions.
- Web activation: **PASS** — allowlisted `index.html` and theme assets replaced with the index published last, two new hashed assets installed, excluded root entries preserved (no API entry), old assets retained and rollback bytes preserved.
- Backend activation: **PASS** — the exact workstreams bundle activated in the foreground process with a `plugin.updated` event, unchanged configuration hashes (`configModified: false`) and no goal resume (`goalsResumed: false`).
- A concurrent backend change was detected during the work, but the live-versus-candidate diff contained **only** the intended nullable-projection changes; nothing unrelated was overwritten. A fresh current-source typecheck plus backend tests passed **159 tests, 936 assertions, 0 failures**; the rebuilt candidate was byte-identical to the activated bytes.
- The first default-catalog Goals attempt was refused because the catalog did not identify the exact local root source (`installedIntent: false`, no effects). The default workspace location stayed unloaded by that path.
- A scoped CLI wrapper added a directory header over the same authenticated CLI. Scoped activation: **PASS** — exact build activated in the same foreground process, with `plugin.updated`, unchanged configuration and no goal resume.
- Native Code Mode `get` after activation returned the same goal with both limits `null`. Usage accounting increased from baseline as expected (`usageAccountingOnly: true`), and the bridge reported verified events with observing/recovery waiting. Legacy explicit-stop preservation was verified in isolated acceptance tests, not by resuming or mutating other live goals. No restart, eviction, state edit, usage reset or unrelated configuration change was performed.
- The temporary effects policy was restored byte-for-byte.
- The activated build contains the previously staged passive-telemetry and per-server isolation code, now active at this observed location; no claim is made about any other process or location.
- An independent final activation review completed read-only: **scoped activation PASS; unconditional whole-workflow sign-off BLOCKED**. The report independently confirmed exact bytes and backups, same-process catalog, live passive schema v2 with null limits, retained accounting and all 12 configuration fingerprints.

## Final review limitations and handoff

The live target remained paused for restart. The coordinator's supported plan update produced a new goal revision; no full-state equality is claimed. Independent passive observation recorded the same usage increase from baseline with turn/time counters unchanged. No other live legacy goals were enumerated or resumed.

1. **Live dashboard integration remains unverified.** The partial/truncated roster omitted the target parent. Real consumer and web validators accepted the live snapshot in offline composition, but that is not live HTTP/SSE/browser projection proof. Workstreams can retain its process-global telemetry object across watcher updates; its module-bound parser generation was not established by installed bytes or plugin-load events. Any reader-generation change or lifecycle action requires separately scoped implementation and verification.
2. **Broader ownership continuity remains unverified.** The baseline owner-lock count exceeded the final inventory, and some baseline paths were absent. Normal runtime disposal can release owned locks, so this is not evidence of manual deletion. The target's ownership worked. No lock was deleted, recreated or reclaimed by deployment or review, and no all-location equality is claimed.

Activation remains installed. The verification Goal must not be marked complete while these acceptance gaps remain unresolved. Do not restart a server, manipulate locks or downgrade schema-v2 state to manufacture a passing result.
