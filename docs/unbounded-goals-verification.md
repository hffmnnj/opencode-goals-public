# Ceiling-free Goals verification

Status: **source and external candidates verified; not activated**.
User instruction: “Remove limits entirely.” This supersedes the unactivated
increase-limits design. The scope is goal/session turn, active-time and token
spending ceilings, not permissions or structural safety bounds.

## Implemented contract

- No resource-budget defaults, gates, clamps, setters or increase API remain.
  Twelve lifecycle tools remain. Usage, high-water marks and charged admissions
  remain cumulative; they are not a provider-enforced cost cap.
- Canonical state and passive snapshots use schema v2 and literal null limits.
  Legacy v1 state and valid old configuration remain readable; old configuration
  cannot restrict execution. Existing storage keys and historical audits remain.
- Legacy budget stops retain durable explicit stop intent and require separate
  guarded reconciliation/resume. Pause/cancel, restrictions, permissions,
  no-progress, owner and exact uncertain-delivery safeguards remain.
- Workstreams accepts v1 numeric and v2 null snapshots with version-specific
  validation. The web validator accepts null, and its exported SessionOverview
  usage line omits finite denominators. Legacy numeric rendering is preserved.

## Checks and evidence

A private evidence directory, independent report and integration log were retained outside the project.

| Check | Observed result |
| --- | --- |
| Goals complete suite and typecheck | 279 tests, 1,750 assertions; passed |
| Workstreams complete suite and typecheck | 159 tests, 936 assertions; passed |
| Web complete suite and typecheck | 234 tests; passed |
| Three external production builds | Passed; independently rebuilt assets match candidates |
| Real producer → consumer → web validator | Null limits, 150,000,015 tokens, 1,000 active seconds, passive zero writes/mutation |
| Pinned V2 2.0.25 Code Mode preflight | Twelve paths, null caps, append/stale checks, two successful native executions despite tiny ignored legacy config |
| Pinned V2 lifecycle | Nineteen checks, all twelve successful RPCs, strict setter rejection, persistence/restart without replay |
| Explicit create/resume command smokes | Each passed, five protocol calls and one successful execution |
| Native recovery | active_defer, no_progress, restart, delayed_cancel passed |
| Browser fixture | Actual App accepts null at 1280×633 and 390×844; no document overflow or invented cap observed |
| Protected fingerprints | Production root/dist and startup/binding/ownership files unchanged |

Independent review found no material implementation/security defect. Its sole
documentation finding was an ambiguous historical activation claim in README;
the wording now explicitly separates historical installation from this
unactivated candidate. The original finding remains in the independent report.

Two initial lifecycle runs failed due to harness expectations: reading full
criteria from a compact pause summary, then expecting service JSON instead of
native HTTP 400 input rejection. The final harness fetches the real full record
and accepts only the specific typed invalid-input rejection. Preserved failed
artifacts and the successful final run distinguish these corrections from
product defects. No production source changed for either correction.

## Activation and coverage boundary

No production bundle/root shim, live config/state/owner file, server restart or
eviction was changed for this work. No Git publication or dependency changes.
The candidate includes previously staged isolation/telemetry source, so local verification must not be presented as approval to silently activate that work. The exact candidate SHA-256 was recorded in the private activation evidence.

Real authenticated HTTP snapshot → live workstreams → live web/SSE was not
exercised. Browser QA used synthetic local data with unavailable SSE/trace by
construction, not live accounts. Current App does not mount the exported
SessionOverview; its changed usage paragraph has real rendered jsdom coverage,
not browser-route coverage. Keyboard-only navigation, physical mobile hardware,
all routes/themes, watcher reload and real-provider billing were not certified.
Existing non-module theme/chunk-size build advisories remain out of scope.
