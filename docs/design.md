# Design decisions

Status: core design accepted after independent engineering review, pinned Codex inspection and an actual V2 2.0.25 context/storage probe. Runtime integration must pass the same-server checks below before automation is enabled.

## Agent-first, not permission-free

Agents may create and maintain a goal when useful for a substantial user task. No separate explicit-user-request gate or command is required for bookkeeping. Creating a goal does not authorize unrelated work, new spending, commits, publication, destructive actions, or privilege escalation.

Goal operations must never auto-answer ordinary OpenCode permission requests. A paused goal, a user interruption, a failed turn, a restricted agent, and a legacy budget hold are stop conditions, not obstacles to route around.

## State and ownership

- One current goal per session; closed goals remain inspectable as history.
- Goals have stable IDs, a revision, objective, acceptance criteria, structured plan, checkpoints, usage accounting, status and lifecycle events.
- Bind ownership to the actual tool context / command invocation session, never an agent-supplied session ID. Integration RPC must validate session location.
- All mutation surfaces call the same service. Serialize per-session writes and require expected revisions for edits that can overwrite concurrent progress.
- Preserve evidence when plans change. Do not silently drop completed tasks or overwrite the original objective during a checkpoint.
- Incremental `tools.goals.plan` append through `execute` accepts only new steps, preserving all existing work and returning the same compact mutation summary. It retains optimistic revision checks, ID uniqueness and the total 64-step capacity; it is not an unchecked merge and never resets usage.
- Completion requires evidence and finished required plan work; blocked/unmet requires a concrete blocker. A model's final answer or an idle session alone never completes a goal.
- Storage is globally plugin-scoped, not location-scoped (verified in a real host). Qualify session envelopes by their owner location. Child/fork/moved sessions do not inherit an armed scheduler. Preserve previous-location records rather than silently transporting executable work.
- Hold an exclusive OS-level ownership file per location/runtime with a unique token; fail closed on an existing live owner. A local mutex alone is not cross-process exclusion. Dispose releases only its own lock token and rejects old captured executors.

## Continuation

Use native session admissions, not shell-driven CLI loops. Continue only after a successful idle boundary when the current goal is active, the session belongs to this location, no user input is pending, and non-budget safeguards (pause/cancel, permissions, no-progress, ownership, delivery proof) permit another turn. There is no turn, active-time or observed-token spending ceiling.

On the pinned host, observe a fresh `session.execution.succeeded`, await native read-only `session.wait`, and correlate the persisted successful idle message with `session.time.idle`. There is no emitted `session.idle` event in the tested release. The idle message precedes the terminal event timestamp. A bounded provisional locationless start may be retained, but actual session ownership must be verified before it authorizes any action. Superseding execution, lifecycle change and disposal abort the observation, not the user's execution.

Persist a continuation intent before admission. An ambiguous admission failure or process restart must reconcile or pause, never blindly resubmit. Per-runtime serialization alone is not cross-process exactly-once execution; document actual guarantees and choose conservative restart behavior. Downgrade from v2 to old strict v1 readers is unsupported without a compatible migration: old v1 records remain accepted and normalize to v2, but old strict readers reject v2 null-limit metadata, so preserve usage/state and never roll back state on downgrade.

No turn, active-time or observed-token spending ceiling gates any start, resume or continuation. Explain token accounting: plugin observation is cumulative accounting only, not a provider-enforced hard token cap. Usage, high-water accounting, active elapsed time and charged admissions remain durable with no resets/refunds. Legacy budget holds stay held until explicit reconciled resume.

Usage is the native bound session's reported cumulative usage, not an independent cross-session billing ledger. Unlike Codex's explicit descendant roll-up, this plugin does not separately traverse child sessions or promise to include usage the host does not attribute to the bound session. Cumulative usage therefore cannot be interpreted as a hard total-cost cap for all subagent work.

### Ceiling-free policy and bridge policy

- Agent operations use native V2 Code Mode registration (`options: { namespace: "goals", codemode: true }`), with no direct `goals_*` model tools, pinning or MCP wrapper. Agents discover signatures with `search` inside `execute` and await `tools.goals.*`. The original native tool executor still supplies the calling session, agent and AbortSignal; RPC and slash commands retain their existing validated paths. Mutation summaries point to `tools.goals.get` for full inspection. Policy, truncated-context notices and continuation inputs use the same Code Mode names.

- No spending ceilings: new state is `schemaVersion: 2` with goal/session `limits: null` as the only current representation. There are no numeric defaults, clamps, exhaustion checks, budget-triggered stops or limit setters. Configured `goalLimits`/`sessionLimits` are deprecated ignored compatibility input. `create`/`revise` accept objective/criteria/plan only and reject `limits` input; `increase_limits` is removed (12 lifecycle operations). Admissions include guarded explicit starts. Active seconds measure wall-clock time while status is active, including idle time, not only model execution; paused time and the restart gap are excluded, as cumulative accounting. Goal replacement and pause/resume never reset session usage. Legacy v1 envelopes remain readable and normalize to v2 without changing usage/high-water, IDs, scope, evidence, reservations or namespaces; retained historical audits are preserved. A legacy budget-paused goal still needs a separate explicit `resume` with `recover: true` and runtime reconciliation, and legacy stops are never auto-resumed.
- Generic plugin default: automation off; all native bookkeeping remains available. A specific installation may explicitly enable automation with trusted configuration once actual-runtime checks pass.
- In 2.0.25, `ctx.session` lacks inbox/form/active reads and pending inbox cancellation. A same-server bridge is therefore needed for safe scheduling. Bind to a managed-service registration only when its PID matches the loading process; otherwise discover only an unambiguous literal-loopback listener held by that process. An optional configured URL only selects an already owned listener and preserves the matching legacy identity; it is never contacted without process ownership proof. Disable redirects, retain bounded requests, and verify `/api/info.pid === process.pid` plus the pinned version before any owner lock or goal-storage access. Never scan or switch to another process's server. Failed identity/authentication remains fail-closed; later inaccessible or invalid reads prevent scheduling rather than weaken checks. No credential is copied into plugin options or logs.
- Managed-service authentication uses the private registration password only when the registration belongs to the current PID; all other bindings use the configured credential environment. The registration is read through a no-follow, owner/mode/size-checked path, its loopback URL is validated, and the PID is checked before a request. The configured `api.baseURL` remains optional and can preserve a verified legacy foreground identity while serving as a fallback.
- Separate each server's owner lock and all goal storage keys by the same stable logical namespace. A matching managed service uses a hash of its stable registration path rather than its changing PID or dynamically allocated port. A process-owned listener uses its canonical endpoint identity. The configured foreground server's legacy keys and lock hash remain unchanged; no legacy state migration or fallback read is performed by other instances. This protects plugin-owned state only: OpenCode's native session database remains shared, so this is not a guarantee of separate session identity or cross-server exactly-once scheduling.
- Server identity is also required for bookkeeping-only configurations with no bridge credentials. The current safe resolver uses Linux `/proc` socket ownership, including to validate the managed-service URL. On hosts without this process-local identity evidence, setup fails closed rather than sending credentials to a merely configured loopback endpoint; expose a host identity in a future V2 context instead of weakening this check. Probe startup credentials remain an isolated-test mechanism.
- Check current session location/agent, foreground activity, every pending inbox type, permissions and forms before each dispatch. Unknown/custom execution agents default to no automation; trusted allowlist plus effective restrictions determines eligibility. Never switch agents or auto-answer permission requests.

### Stop and recovery guarantees

Pause/cancel immediately invalidates future scheduler decisions and delayed work. Attempt withdrawal only of the plugin's own undelivered admission. Already delivered work may finish; the plugin does not interrupt unrelated user execution. V2 lacks an atomic idle-only admission transaction, so checks reduce but cannot eliminate the race between observation and admission. Do not claim exactly-once execution or instantaneous cancellation.

Keep a stable `msg_` ID, reserve allowance and persist intent before admission. A failed/uncertain admission consumes the reservation and pauses. Restart/reload pauses recovered active goals and never automatically retries ambiguous input. Restoring a system safety pause requires **adapter-verified reconciliation**, not a caller-supplied authority flag. An agent may request reconciliation through resume, without human approval; the runtime must inspect actual same-server ownership, pending delivery and current execution state before granting it. During active or background work that request returns scheduled/waiting diagnostics without waiting on its own turn; a later observed idle/background/restart boundary may admit one fresh continuation, never a replay or refund. Ordinary follow-ups keep active authorization, withdraw only stale automation, and never become silent manual pauses. Background shells/children wait free while busy and recheck once on correlated completion. Explicit stops persist across reload with conservative legacy inference. Only fresh substantive verification progress lifts `no_progress`; restatements and duplicates stay held. Failed/interrupted work needs fresh user authorization or an explicit request. Ordinary bookkeeping remains available. Consumed usage is never refunded or reset, and there is no ceiling-raising API (never usage credit, progress, or resume); missing pending input alone is not proof it was never delivered. Generic defaults remain automation-off.

## Context and compaction

Inject a compact, escaped snapshot with the objective, status, remaining criteria, current plan focus, recent evidence and cumulative usage (no finite denominators). Delimit all goal fields as untrusted task data. Keep durable state outside conversation history and re-read it after compaction rather than trusting an old summary.

## Human commands

Provide a discoverable `/goal` entry point and direct status/pause/resume/cancel/history controls. Commands operate on the same durable state as tools; no parsing ambiguity turns a status request into a new objective. Simple management never requires an LLM call. In the pinned API, its output is a queued passive synthetic notice, not an immediate transcript append; disclose this limitation rather than claiming delivered output. Explicit create/resume starts are charged admissions and add no competing notice when successful.

## Test priorities

Behavior-focused tests cover: concurrent writes, stale revisions, terminal transitions, plan evidence retention, command parsing, restricted agents, failed/interrupted turns, pending user prompts, duplicate idle notifications, usage-accounting preservation, persistence failures, ambiguous admissions, restart recovery and compaction context. A fake plugin context can test wiring but cannot establish V2 API compatibility; add an actual V2 smoke test.

## Supporting research

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): explicit progress artifacts, incremental work and verification before marking completion. This informs progress design, not automatic Git commits.
- [Durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution): persisted checkpoints and replay boundaries.
- [Idempotency and retries](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/): durable checkpoints do not by themselves make external effects exactly once.
- [OpenAI Agents human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/): preserve action-level permission boundaries even when high-level goal management is autonomous.

Pinned Codex findings, adopted patterns and explicit divergences are in [codex-research.md](codex-research.md). Native API probe evidence is in [native-probe.md](native-probe.md).
