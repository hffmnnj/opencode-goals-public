# Ceiling-free Goals

## Request and supersession

Latest user instruction: **“Remove limits entirely.”** This supersedes the
unfinished limit-increase design, including its F1 correction. Remove all
goal/session admission-count, active-time and observed-token ceilings. Do not
replace them with large numbers, Infinity, configurable escape hatches or a
different budget-increase API.

## Retained behavior

Usage, normalized token high-water accounting, active elapsed time and charged
admissions remain durable and cumulative. No usage resets/refunds. Preserve
pause/cancel/block, explicit stops, agent restrictions, native permissions/forms,
no-progress detection, background deferral, owner/location/server identity,
dispatch fences and exact uncertain-delivery reconciliation. Structural input,
queue, retention and numeric representation bounds are not resource budgets
and remain. Do not modify unrelated per-server isolation implementation.

## Canonical contracts

- New state has `schemaVersion: 2`, with goal/session `limits: null` as the only
  current representation. Usage remains required. No numeric ceiling defaults,
  minimum/grant clamp, exhaustion check, budget-triggered stop or limit setter.
- Remove `increase_limits` from service/tool/RPC/runtime; return to 12 lifecycle
  tools. Remove limit patches from new create/revise public inputs. Reject stale
  setter input explicitly rather than advertising an ignored setter.
- Accept old configured `goalLimits` / `sessionLimits` as deprecated ignored
  compatibility input; they cannot affect execution. Do not edit live config
  during this source change.
- Read legacy v1 envelopes (including optional grants, old before/after audits,
  and unverified F1 `budgetResumeRequired` metadata) and normalize to v2 without
  changing usage/high-water, IDs, scope, evidence, reservations or namespaces.
  Retain historical audit records. New v2 storage uses existing qualified keys,
  not a new empty namespace. Older strict readers cannot safely downgrade v2.
- Legacy budget pauses remain held and require an explicit resume; removal is
  not permission to auto-resume them. Preserve that stop intent across event
  failures/reloads/other diagnostic hold transitions. Unknown delivery remains
  pending until existing exact native reconciliation. Normal unrelated internal
  recovery must continue working. Finish or supersede the F1 WIP deliberately,
  not by simply dropping its safety intent.
- Passive `goals.snapshot` becomes schema v2. Keep its existing usage/units and
  budget container for integration continuity, but both `limits` are literally
  null; no numeric substitute or stale persisted limit is reported as enforced.
  Observation remains passive: no recovery, accounting, writes or scheduling.
- Update workstreams' source consumer to accept legacy v1 numeric snapshots and
  v2 null-limit snapshots. Its `GoalSummary.data.limits` supports null. Validate
  version-specific meanings; do not accept a fake numeric v2 cap. Amend
   BOARD-API.md explicitly. Update the sibling `opencode-workstreams-web` strict
   reader and existing usage line to accept null and omit finite denominators;
   retain legacy numeric rendering. No UI redesign or bundle activation.
- Commands/context/docs show usage without finite denominators; public
  diagnostics describe usage accounting rather than admission-limit enforcement.

## Workstreams and ownership

1. Engineer: Goals schemas/state machine/runtime/contracts/commands and focused
   tests; one writer, no live builds/actions. Rework obsolete budget tests into
   unbounded/accounting/preservation regressions without dropping other safety
   coverage. Preserve unverified prior edits until understood.
2. Minion, sequential: workstreams' small schema/projection compatibility change,
   focused tests and BOARD-API amendment, then the sibling web reader/types and
   null-safe existing usage line. No live dist/entrypoint edits.
3. Minion, sequential: update current Goals docs and native acceptance scripts
   for 12 operations and unbounded execution, retaining historical reports.
4. Coordinator: integrate and build only external candidates; run fresh local
   suites/native checks; full-verifier independently audits finished workflow.

## Acceptance

1. No default/configured/persisted/agent-supplied numeric resource ceiling gates
   any start, resume or continuation, including above former goal/session limits.
2. New state/public/passive values are truthfully unbounded. Old records/config
   remain readable without usage loss; v1/v2 consumer compatibility is tested.
3. Legacy stop composition (including F1 event failure/restart), explicit stops,
   no-progress, restrictions, permissions, owners and uncertain delivery retain
   behavioral coverage. No automatic legacy resume or replay.
4. Fresh types, complete local suites, external builds and isolated pinned-V2
   discovery/execution/accounting/restart checks pass; independent final review
   has no unresolved material findings. Reports distinguish old increase-candidate
   evidence from this new candidate.
5. Document the absence of spending ceilings and precise activation status.
   Production bundles/root shims/config/state/owner files stay untouched until
   any separately safe activation decision; in-progress isolation work must not
   be silently activated with this feature.

No Git initialization/publication, dependency additions, server restart/eviction,
live state edits, retention redesign or unrelated defect fixes are authorized.
