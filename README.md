# opencode-goals

Agent-first durable goal plugin for OpenCode V2 (exact `2.0.32`; see
[goals-only verification](docs/goals-only-verification.md)). Agents can
create and maintain session goals through native Code Mode tools — no user
command or separate approval is required for goal bookkeeping. Historical
`2.0.25` references retained below are history, not the current target: the
current SDK requires a newer host domain, so `2.0.25` is no longer supported
by this restored build. Human slash
commands (`/goal`, `/pause_goal`, `/resume_goal`) are backed by the same goal
service and the same validated state transitions.

**Source status:** standalone native Goals only, per
[goals-only restoration](docs/goals-only-spec.md). The board-only
`goals.snapshot` RPC, its schemas, `service.peek`, and
`runtime.passiveSnapshot` are removed from this plugin; the twelve native
Goals lifecycle operations, typed `GoalsRPC`, slash commands, persistence,
usage accounting, and continuation safeguards are preserved. The separate
Workboard/state-manager application is unchanged. Type checking, 263 tests,
the build, isolated native lifecycle/watcher and automatic-continuation checks
passed. The rebuilt plugin is active in the observed OpenCode V2 `2.0.32`
configuration location, with twelve Code Mode tools and all three commands,
without restarting the server. Exact evidence and remaining verification
boundaries are in [goals-only verification](docs/goals-only-verification.md).

## Agent tools

Tools are discoverable under the `goals` namespace **inside `execute`**. There
are no separate direct `goals_*` model tools, no MCP shim and no enablement
command. They derive the session, agent and cancellation signal from the native
tool context (never from agent-supplied identity) and never wake the session on
their own. Discover the needed signatures first, for example:

```js
// Code passed to execute({ code: ... }); search is synchronous.
return search({ namespace: "goals", query: "create", limit: 1 });
```

- `tools.goals.get` — inspect the full current goal, content revision, diagnostics
  and bounded archive summaries.
- `tools.goals.create` — create a goal for a substantial task. Requires `objective`
  and at least one acceptance criterion. Does not grant work permissions.
- `tools.goals.revise` — revise objective/criteria with the
  current goal ID and content revision. Verified scope is preserved.
  `limits`/`sessionLimits` inputs are rejected; there is no limit setter.
- `tools.goals.plan` — replace (default) the structured plan without removing completed steps
  or evidence. Pass `mode: "append"` with only new steps to append without rewriting.
- `tools.goals.evidence` — record real, reported verification evidence for one
  acceptance criterion.
- `tools.goals.checkpoint` — record progress, evidence and next step.
- `tools.goals.complete` — complete only after ALL criteria have reported evidence
  and all required work is finished.
- `tools.goals.block` — record a concrete blocker and stop automatic continuation.
- `tools.goals.pause` / `tools.goals.cancel` — idempotently stop future automation.
- `tools.goals.resume` — explicitly resume a held goal.
  `recover: true` REQUESTS same-server reconciliation; it is not a trusted
  bypass and restricted agents cannot resume execution. A legacy budget-paused
  goal stays paused until a separate `resume`
  (`recover: true`) with runtime reconciliation; there is no automatic resume
  and no spending ceiling to raise.
- `tools.goals.history` — bounded lifecycle history without waking the model.

Example code for `execute`: create a goal, then use its returned current ID and
revision when recording evidence or appending steps as work is verified. Each
mutation returns the new revision; inspect with `tools.goals.get` when needed.

```js
return await tools.goals.create({
  objective: "Wire checkout form validation end to end",
  criteria: [{ id: "accept", description: "Invalid input is rejected with a visible error" }],
});
```

```js
return await tools.goals.evidence({
  goalId: "goal_<id>", expectedRevision: 1, criterionId: "accept",
  evidence: { summary: "Focused form test passes", reference: "tests/checkout.test.ts" },
});
```

```js
return await tools.goals.plan({
  goalId: "goal_<id>", expectedRevision: 2, mode: "append",
  steps: [{ id: "verify", description: "Add focused verification", status: "pending" }],
  reason: "Extend plan without rewriting completed steps",
});
```

Advanced structured plans, criteria and evidence use these tools or the typed
RPC (`GoalsRPC`, id `goals`); the slash commands deliberately do not offer a
brittle shell-like grammar for them.

## Human commands

- `/goal` and `/goal status` — inspect the current goal.
- `/goal help` — command syntax.
- `/goal history` — bounded lifecycle history.
- `/goal create <objective>` — create a goal with a full-objective acceptance
  criterion and deliberately request a guarded start. Unknown words never
  implicitly create or replace a goal.
- `/goal pause [reason]`, `/goal cancel [reason]`, `/goal clear [reason]` —
  stop future automation. `clear` is a history-preserving cancellation alias,
  not deletion.
- `/goal resume` — ordinary resume plus a guarded start.
  `/goal resume --recover` requests adapter reconciliation, not permission to
  bypass a safety hold.
- `/pause_goal` and `/resume_goal` — familiar aliases.

Read-only and stop commands never wake a model. On V2 2.0.32 there is no
immediate command-output surface: replies are queued passive notices
(synthetic context with `resume: false`), not already-delivered transcript
messages. Successful create/resume starts intentionally add no competing
passive notice ahead of their own admission; if a start fails, the command
reports the state and diagnostics honestly through a passive notice instead.

## Autonomous recovery

Agent-requested `recover: true` during active or background work returns a
scheduled/waiting result, not an actual resume. The runtime rechecks at an
observed native idle boundary and may then admit one new continuation
with a fresh ID. Ordinary follow-ups keep the goal active (not a manual pause),
invalidate stale automation, and yield to new input, forms, permissions and
background work. Background shells/children defer without charge while busy;
correlated completion rechecks once. Explicit stops persist across reload
(conservative legacy inference preserved); only fresh substantive progress
lifts a `no_progress` hold. Failed/interrupted work needs new user authorization
or an explicit request; unknown delivery is never auto-retried. Reservations
stay charged: no refunds or usage rollbacks. There is no turn, active-time or
observed-token spending ceiling: `create`/`revise` accept no `limits` input,
there is no limit setter, and no automatic refund or usage rollback exists.
Legacy budget-paused goals stay paused until a separate explicit reconciled
`resume`; removal is not permission to auto-resume them.
A saved source bundle backup is not a license to roll back persisted usage/state. Generic
defaults remain automation-off; automation requires explicit trusted
configuration.

## Options and safe defaults

Generic defaults are fail-closed: `autoContinue: false`, so the plugin keeps
books but never admits automatic turns unless explicitly enabled.

No spending ceilings. New state uses `schemaVersion: 2` with goal and session
`limits: null` as the only current representation; `create`/`revise` reject
`limits` input and there is no setter, default, clamp, enforcement or grant.
Configured `goalLimits` / `sessionLimits` remain accepted as deprecated ignored
compatibility input and never affect execution.

- Active seconds are wall-clock time while the goal's status is active, including
  idle time, not just model execution. Paused time and the restart gap are excluded.
  They are cumulative accounting, not a ceiling.
- Existing persisted usage remains unchanged: reload never raises, refunds or
  resets usage. Legacy v1 envelopes remain readable and normalize to v2 without
  changing usage/high-water, IDs, scope, evidence, reservations or namespaces.
- Explicit starts count too: `/goal create` and `/goal resume` admissions are
  charged to the same cumulative goal/session usage even with `autoContinue`
  off — accounting is not “automatic only”.
- Legacy budget holds stay held and require an explicit reconciled resume;
  removal is not permission to auto-resume them. Explicit pause/cancel still stops.

Token accounting follows V2's normalized session usage: the observed total
sums input + output + reasoning + cache reads + cache writes. Plugin
observation is accounting only, not a provider-enforced hard cap.
The plugin does not independently aggregate child-session usage: it charges
what V2 reports for the bound session, not a hard total-cost cap for all subagents.

Fixed goal policy remains in the system instructions. Live goal state and usage
are supplied as quoted task data at the outgoing conversation tail for primary
and compaction requests. Updates remain live without rewriting the fixed system
or existing history, and these transient blocks are not stored as user prompts.

Full option set (`RuntimeOptionsSchema` in `src/options.ts`): `autoContinue`,
`goalLimits` / `sessionLimits` (deprecated ignored compatibility input; never
used for execution or new state), `maxNoProgress`
(default 2), `maxArchives` (5), `maxHistory` (100), `maxCheckpoints` (20),
`api` (same-server loopback bridge, below), `allowAgents` (default
`["build"]`), `contextChars` (default 6000).

the user's local configuration enables automation for `build`. The bridge binds to
the server process that loaded the plugin; no port is required for managed
services or an unambiguous process-owned loopback listener. Generic package
defaults remain non-automatic. Example configuration shape (merge the plugin
entry into your existing configuration; do not replace unrelated settings),
exercised by `scripts/native-lifecycle.py`:

```json
{
  "plugins": [
    {
      "package": "<private-path>",
      "options": {
        "autoContinue": true,
        "api": {},
        "allowAgents": ["build"]
      }
    }
  ]
}
```

- `api` enables safe automatic continuation. `api.baseURL` is optional; when
  present it must be a literal loopback root URL without credentials. It can
  select an owned listener and preserve existing foreground state, but is never
  used unless that endpoint is proven to belong to the current process.
- A matching managed-service registration is used only when its PID is the
  plugin process. Otherwise, Linux instances discover an unambiguous loopback
  listener held by their own process. The `/api/info` PID and exact 2.0.32 version are
  still verified before any owner lock or goal record is accessed. If the
  process cannot be identified safely, setup fails closed without claiming a
  lock. The bridge never starts or switches to another server.
- Managed-service authentication uses that same-PID registration's private
  password; other bindings use the existing
  `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` environment
  (overridable via `usernameEnv` / `passwordEnv`, which name variables only).
  No credential value is copied into plugin options, persisted goal state or
  diagnostics.
- Each server has matching, separate owner and storage namespaces. The existing
  configured foreground server retains its legacy key and lock paths; another
  managed service gets its own stable namespace. Failed authentication,
  identity mismatch or unreachable/invalid endpoints fail before ownership
  acquisition. After startup, inaccessible or unverified reads prevent
  scheduling rather than weakening checks. Unknown/custom execution agents
  default to no automation.
- When `api` is omitted, bookkeeping remains available without API credentials;
  the plugin still requires a unique process-owned listener or matching
  managed-service registration to isolate its lock and storage. If it cannot
  identify the loading server safely, setup fails closed rather than sharing a
  global goal namespace.

## Limitations

- **Same-process native API.** In 2.0.32 `ctx.session` exposes no inbox, form
  or active-session reads and no pending-inbox cancellation, so safe
  scheduling needs the same-server bridge above. Safe process identity
  currently relies on Linux `/proc` socket ownership (including for managed
  service URLs). On platforms without it, setup fails closed rather than send
  credentials to an unverified endpoint; host-provided server identity is the
  preferred future integration.
- **No atomic admission (TOCTOU).** An inbox read followed by admission is not
  an atomic transaction: checks reduce but cannot eliminate the race between
  observation and admission. Already-delivered work may finish; the plugin
  never interrupts unrelated user execution, claims exactly-once execution,
  or promises instantaneous cancellation. Failed or ambiguous admissions stay
  charged, pause, and require reconciliation — never blind resubmission.
- **Restart reconciliation.** Reload first holds recovered active goals
  (`restart`), never replaying old input. With automation enabled, healthy
  observations schedule adapter-verified recovery at a safe native boundary;
  an agent can also request it with `recover: true`, without a human command.
  Ownership, policy, pending work and exact cancellation/delivery proof are
  rechecked. Missing proof remains held, explicit stops remain stops, and
  consumed allowance is never refunded.
- **Passive command output.** See “Human commands”: notices are queued
  synthetic context, not transcript replies.
- **No permission bypass.** Goals never approve underlying work, expand the
  user's authorization, auto-answer permission requests, switch agents, or
  reset usage. There is no spending-ceiling API; legacy budget holds require a
  separate explicit reconciled resume. Goal text is quoted task
  data, not policy. Restricted agents
  may plan but cannot execute.

## Native acceptance

Reproducible isolated harnesses live in `scripts/` (stdlib-only Python, no new
dependencies). The restored `native-preflight.py` and `native-lifecycle.py`
harnesses spawn a private real V2 2.0.32 server with separate
XDG/config/data/database paths, a loopback model fixture, random test
credentials and ordinary loopback HTTP headers, then terminates the child and
preserves its artifact directory (nothing is deleted). The plugin under test
defaults to the repository root; the server binary defaults to the exact
2.0.32 release path and `--version` is verified before `serve` starts, and the
live `/api/info` response must report that same version with the spawned
process PID. `GOALS_EXPECTED_VERSION` supports only `2.0.32` (the default).
Both restored harnesses passed on the current release; see
[goals-only verification](docs/goals-only-verification.md). Other
native-recovery/background harnesses still target the historical 2.0.25 host
and are not evidence for this restored release. Never
use the default `opencode` (V1) binary or the `opencodev2` live-config wrapper
to spawn an isolated server — the scripts refuse those basenames. Isolated
configs set `warming: false` and `update: 'disable'` so the scripted fixture
stays the sole model. The child inherits the operator shell minus provider
credentials, live-service overrides and proxy routing (loopback is forced via
`NO_PROXY`); only versions, session IDs and check names are printed, never
secrets. Live-service installation status is the coordinator’s verification
record, not this file’s claim.

```sh
python3 scripts/native-preflight.py --goals
python3 scripts/native-preflight.py --goals --command
python3 scripts/native-preflight.py --goals --resume-command
python3 scripts/native-lifecycle.py
GOALS_WATCHER_TEST=1 python3 scripts/native-lifecycle.py
```

The harnesses wait for terminal `session.execution.succeeded` outcomes; a
`failed` or `interrupted` outcome stops the run rather than retrying, matching
the plugin’s own failure handling. Useful overrides: `OPENCODE_V2_BIN`,
`GOALS_PLUGIN_PATH`, `GOALS_PLUGIN_PLAIN=1`, `GOALS_SMOKE_ROOT`,
`GOALS_SMOKE_TIMEOUT`, `GOALS_WATCHER_TEST=1`,
`GOALS_EXPECTED_VERSION=2.0.32` (only supported value).

Preflight discovers the 12 goal signatures through Code Mode, asserts no direct
`goals_*` tools reach primary model requests, and invokes operations through
`execute`. The automatic case validates null goal/session limits and retained
usage/accounting through a `get` (deprecated tiny legacy `goalLimits`/
`sessionLimits` of 1 each remain configured but ignored) before verifying append
preservation and stale-edit rejection, then continuation/completion. Search only needed signatures during
normal agent work; dumping every large result schema can exceed host output bounds.

## Research

- [Design decisions](docs/design.md) — agent-first authority, ownership,
  ceiling-free continuation and command surface.
- [Pinned Codex research](docs/codex-research.md) — adopted and rejected
  upstream patterns.
- [V2 API research](docs/v2-api-research.md) — historical pinned 2.0.25 contracts and
  normalized token accounting (retained as history; current target is exact 2.0.32).
- [Native probe](docs/native-probe.md) — real-host storage/context findings.
- [Legacy audit](docs/legacy-audit.md) — previous plugin and state paths.
- [Acceptance matrix](docs/acceptance.md) — contract/fault/check boundaries.
- [Budget verification](docs/budget-verification.md) — **superseded** finite-ceiling
  history: Codex comparison, higher defaults and preservation of existing
  allowances. Retained for historical evidence; not the current contract.
- [Code Mode verification](docs/codemode-verification.md) — current registration,
  real native search/execute scenarios and installed checks.
- [Goals-only restoration](docs/goals-only-spec.md) — removes the
  board-only snapshot surface; standalone Goals remain.
- [Goals-only verification](docs/goals-only-verification.md) — current
  build, test, native lifecycle/continuation, and activation evidence.

## Packaging and loader note

`package.json` keeps `exports["."]` primary on `./dist/index.js`; `./rpc`
points at `./src/rpc.ts`, so the published file list also includes the `src`
sources it imports, plus `scripts/` and `docs/` (linked above) and the root
`index.ts` shim. The root `index.ts` compatibility shim (`export { default }
from './dist/index.js'`) exists because the historical pinned 2.0.25 directory plugin
loader resolved the package directory itself and ignored `exports["."]` alone
— a package with only that export did not appear in the loaded plugin list in
an isolated probe. Directory loading also passed in the restored exact 2.0.32
native checks; see [goals-only verification](docs/goals-only-verification.md).
Configure the plugin by **directory path**; direct file
paths are rejected by the pinned host (“configured plugin path must be a
directory”) and must not be relied on. No `./server` alias is provided; the
shim alone was the verified fix.

## Migration and rollback

Historical installation evidence: [Code Mode verification](docs/codemode-verification.md);
older checkpoints remain in the [original verification record](docs/verification.md).
These observations concern earlier installed versions, not activation of the
ceiling-free or isolation candidates. The board-only passive-telemetry
candidate ([passive workstreams telemetry](docs/passive-workstreams-telemetry.md),
now marked superseded/removed) is not part of the Goals-only contract and
is not reactivated by this restoration. The finite-ceiling
[budget verification](docs/budget-verification.md) is retained as **superseded**
history, not the current source contract. At that historical checkpoint, the
replacement was active in all nine loaded foreground locations, with all nine
owner records belonging to the unchanged foreground process. The earlier example-project deferral converged during
normal watched updates without restart, eviction or manual owner-file changes.
The legacy plugin was absent from all nine foreground plugin inventories.
Never delete live lock files or infer that a failed inventory entry has no restored
activation. Known unrelated edge defects remain tracked in
[feature verification](docs/feature-verification.md).

- Legacy state (`@prevalentware/opencode-goal-plugin`, e.g.
  `~/.local/share/opencode-v2/opencode-goal-plugin/goals.json`) is **never
  silently imported or destroyed**. The new plugin starts from its own
  location-qualified storage; preserve the old state file with private
  permissions.
- Installation: read the live config immediately before editing, back up the
  exact current config with private permissions, and replace **only** the old
  plugin entry with the new local package directory path. Preserve all
  unrelated settings and concurrent changes.
- Rollback: restore **only the plugin entry** from backup (merge, do not
  overwrite the whole file if unrelated user changes landed after the
  backup), then verify the legacy plugin loads and the replacement is absent
  against the live service.
