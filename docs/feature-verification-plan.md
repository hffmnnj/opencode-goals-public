# Goal feature verification

## Request
Verify all goal features work against the current implementation and installed OpenCode V2 host. Fresh evidence is required; previous acceptance results are context, not a new pass.

## Scope and boundaries
- Run the full declared local type/test/build checks.
- Exercise all 12 public goal operations through a real isolated V2 host, including successful revise/checkpoint/block operations and incremental append, not only negative cases.
- Exercise human command behavior, aliases, passive output, unknown-input rejection and deliberate create/resume starts.
- Recheck native agent-tool execution and automatic continuation with the existing deterministic local provider.
- Verify restart/recovery, watched reload, persistence, budgets, evidence preservation, revision conflicts, restrictions and interruption handling at the appropriate test boundary.
- Independently audit coverage and identify behavior not established by the executed checks.
- Inspect live plugin/command inventories without changing existing user goals, configuration, forms, pending inputs, locks or processes.
- Preserve the explicit decision to leave the managed example-project server running. This request does not authorize eviction, restart or live lock deletion.
- No recursive cleanup. All scratch artifacts must use new unique directories and remain preserved.

## Acceptance
1. Fresh local checks pass or failures are reported with reproductions.
2. Each of the 12 operations has an observed successful real-host result, with rejected invalid transitions tied to retained state.
3. Command, continuation and restart checks have actual native artifacts; scripted-provider checks are not described as external-model judgment.
4. Runtime safety/context/budget coverage is independently reviewed and evidence limitations are explicit.
5. Live activation and legacy absence are rechecked, with example-project's deferred state reported honestly.
6. A feature-by-feature report records commands, results, artifacts, findings and remaining gaps.

## Workstreams
| Workstream | Owner | Status |
| --- | --- | --- |
| Local checks | coordinator | passed: 143 tests / 965 assertions, types and build |
| Complete native management/command coverage | minion + coordinator | passed: all 12 RPCs, 18 checks; coordinator independently reran expanded harness |
| Independent safety and feature coverage audit | engineer + coordinator | completed with three reproduced defects and explicit remaining gaps |
| Native agent execution/continuation and live inventories | coordinator | passed native journeys and packed rerun; live 8/9 remains user-deferred; stale captured executor/fresh success reproduced |
| Final report | coordinator | docs/feature-verification.md records passes, findings, artifacts and limitations; no all-features-clean claim |
