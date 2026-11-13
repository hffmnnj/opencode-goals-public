# Actual Codex source research

## Provenance

Upstream: [openai/codex](https://github.com/openai/codex). Source pinned to commit **`c6327eba6a5a31304c289f2121cc74f56f9a441b`**, dated 2026-10-14T14:28:18Z. An independent explorer verified the SHA with both `git ls-remote ... HEAD` and the GitHub commit API, then fetched the files at that SHA. A local source snapshot was retained privately for line inspection.

Initial researcher reads used `main` and some outputs were truncated. Those were research leads, not final evidence. The pinned second pass inspected the complete continuation path, current migrations and behavioral tests. The coordinator separately reopened runtime lines 400–579, accounting 551–575, the full continuation template, and the current migration.

All line references below refer to the pinned revision, not a moving branch.

## Default budgets compared with this plugin

The pinned upstream goal layer has **no numeric turn cap or time cap**. Its goal state stores elapsed time for accounting, not as a time budget. The token budget is optional: [`GoalsToml.max_goal_token_budget`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/config/src/config_toml.rs#L749-L754) is an `Option<NonZeroU64>` in a default-derived configuration, and [`handle_create`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/ext/goal/src/tool.rs#L204-L214) falls back from an omitted request budget to that optional host setting. With neither set, there is no goal token cap. This describes the unconfigured upstream goal layer, not hosted-client overrides, account quotas or provider rate limits.

After the user requested larger allowances, this plugin deliberately retained finite defaults: **200 admissions / 24 active hours / 20,000,000 observed tokens per new goal**, and **1,000 admissions / 7 active days / 100,000,000 observed tokens per new session**. These are our chosen safeguards, not Codex defaults. Previously persisted tighter goal/session ceilings and consumed usage were not migrated upward.

The token numbers are not directly comparable. Codex subtracts cached input and adds nonnegative output (`accounting.rs:570–574`, linked below); this plugin counts the V2 host's five disjoint normalized categories, including cache reads/writes and reasoning. Repeated large cached prompts can therefore consume our observed-token budget much faster than Codex's goal-token budget. Codex's consecutive-three anti-spin thresholds also use different semantics from our substantive-progress check; increasing budgets does not change our no-progress default of two.

For this comparison, the coordinator independently reopened the pinned configuration source (downloaded with the required User-Agent), creation fallback and token-accounting passages. The additional local copy was retained privately. No upstream Rust tests were run.

## Findings and adopted patterns

### Persisted session contract, not global memory

[`state/goals_migrations/0001_thread_goals.sql`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/state/goals_migrations/0001_thread_goals.sql#L1-L18) stores one goal row per thread, including objective, stable goal ID, status, budget and consumed usage. Current states are active, paused, blocked, usage-limited, budget-limited and complete. The original older migration `0029_thread_goals.sql` is not the current schema authority.

Adopt: session-owned durable state, explicit lifecycle and usage distinct from completion. Extend with structured acceptance criteria, plans, checkpoints, retained history and optimistic revisions.

### Event-driven continuation with a real host admission gate

[`ext/goal/src/runtime.rs:436–535`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/ext/goal/src/runtime.rs#L436-L535) checks tool availability, a continuation deferral and the current persisted active goal. A semaphore spans the read/start window. It then calls the host's `start_turn_if_idle`, marks the admitted turn as goal-triggered, and does not blindly retry a rejected/failed admission. Turn-stop evaluation shares the permit so a fast turn cannot finish before accounting knows its identity.

Adopt: outcome-aware idle scheduling, durable admission intent, reservation before submission, deduplication and lifecycle fencing. **Important V2 difference:** the public 2.0.25 plugin API does not expose Codex's atomic `start_turn_if_idle`. An inbox read followed by admission is not equivalent. The new plugin must document the remaining admission/cancellation race and use conservative same-server checks and queued input rather than claim Codex's stronger guarantee.

### Accounting is serialized and has defined units

[`accounting.rs:551–575`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/ext/goal/src/accounting.rs#L551-L575) computes Codex goal tokens as input minus cached input plus nonnegative output. It does not add reasoning output again. Separate progress-accounting and turn-start locks prevent duplicate deltas and stop/start deadlocks (`accounting.rs:22–25,253–263`; `runtime.rs:559–562`). Descendant usage is rolled up (`accounting.rs:305–311`; `extension.rs:468–475`).

Adopt: explicit monotonic observations, no duplicate charge, no double-counted reasoning, active-time accounting and finite admission limits. Do not silently copy the units: OpenCode exposes a different normalized token structure. Document the plugin's chosen conservative accounting and any descendant-accounting limitation.

### Anti-spin behavior is more nuanced than “no tool call”

[`accounting.rs:121–246`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/ext/goal/src/accounting.rs#L121-L246) distinguishes failed execution tools from successful tools and automatic empty responses from turns with activity. Empty responses and execution failures use consecutive-three thresholds. It is inaccurate to summarize all of this as “any turn without a tool call stops immediately.”

Tests include `ext/goal/tests/accounting.rs:63–228` (activity/reset/replacement matrices), `:231–268` (descendant accounting), and `goal_extension_backend.rs:873–932` (failed execution turns vs a successful tool).

Adopt: a bounded substantive-progress check, failure/interrupt stops and finite total continuation allowance. Checkpoint timestamps or restated plans alone do not constitute progress.

### Plan, failure and interruption are separate lifecycle events

`extension.rs:270–276` clears current-turn goal association in Plan mode. `on_turn_error` (`:423–447`) maps usage-limit errors separately and blocks other failures to prevent compaction/error loops. `runtime.rs:315–374` uses expected goal identity when applying stop transitions so a stale turn cannot alter its replacement.

Adopt: restricted-agent bookkeeping without automatic execution, goal-ID checks, conservative pause after failures/interruption, and no restart replay. Our recovery is deliberately more conservative than Codex's `restore_after_resume` (`runtime.rs:412–434`), which rehydrates active idle state.

### Completion is an evidence audit, not an idle event

[`templates/goals/continuation.md:35–46`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/ext/goal/templates/goals/continuation.md#L35-L46) requires requirement-by-requirement evidence against actual current state and warns against redefining success around partial work. Lines 3–7 mark objective text as task data rather than higher-priority instructions. Lines 22–25 distinguish substantive progress from verified waiting and status restatements.

Adopt these principles in original plugin policy text. Add schema-enforced criterion evidence and unfinished-plan checks. The plugin can validate evidence structure, not independently prove an agent's claim is true.

## Deliberate divergence: agent-first authority

[`spec.rs:46–48,62–83`](https://github.com/openai/codex/blob/c6327eba6a5a31304c289f2121cc74f56f9a441b/codex-rs/ext/goal/src/spec.rs#L46-L83) requires explicit user/system request for creation and user/system control over resume and system-limit transitions. `tool.rs:247–260` enforces the limited model status set.

**Do not copy these gates.** The user explicitly requested agents be able to create, maintain and update goals without a user command or separate approval. This plugin therefore allows autonomous bookkeeping and ordinary lifecycle management while keeping trusted ceilings, restart/ambiguous-dispatch recovery and underlying OpenCode permissions separate. An agent must not reset consumed allowance or raise its configured maximums by replacing a goal.

Codex's repeated-three blocker audit is also not copied as a requirement to waste work on a known authorization blocker. This plugin may stop immediately for a concrete safety/permission/runtime failure.

## Additional verified state/test details

- `state/src/runtime/goals.rs`: goal replacement only when the previous goal is complete; expected-goal-ID guards; accounting modes; preservation/promotion of budget-limited states.
- `state/goals_migrations/0002_thread_goal_continuation_deferrals.sql`: durable thread-scoped continuation deferral.
- `goal_extension_backend.rs:204–259`: only-complete replacement behavior.
- `:762–871`: usage-limit accounting and turn-error blocking.
- `:1050–1085`: stale turn stop is a no-op.
- `:1214–1241`: model cannot resume or set system statuses.
- `:1428–1479`: resume rehydrates active idle goal.

## Gaps and limits of the research

The independent pass did not inspect the underlying core implementation of `ThreadManager::start_turn_if_idle`, TUI argument dispatch callers or analytics. The scheduling call and typed admission result are verified, but the full host implementation is not claimed audited. No Codex Rust tests were executed locally; source tests were inspected as design evidence. The new plugin's correctness must come from its own tests and actual V2 acceptance, not the upstream test suite.

Official explanatory context: [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex). Actual pinned code above is the primary architectural authority.
