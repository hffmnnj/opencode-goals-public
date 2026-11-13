<p align="center">
  <img src="https://unpkg.com/hffmnnj.goals@1.0.0/assets/banner.png" alt="opencode-goals: durable, agent-first goal bookkeeping for OpenCode V2" width="100%">
</p>

# opencode-goals

Durable, agent-first goal bookkeeping for OpenCode V2. Through native Code Mode
tools, agents may create and maintain session goals when useful for a substantial
user task, without a separate bookkeeping request. Humans inspect and steer the
same state through slash commands. A goal holds its objective, acceptance
criteria, structured plan, checkpoints, reported evidence and cumulative usage,
and survives reloads and context compaction.

Goals are bookkeeping, never authority. Creating or updating one does not grant
permissions, approve underlying work, answer permission requests, switch
agents, or expand the user's authorization. Goal text is quoted task data, not
policy. Paused or blocked goals do not authorize execution, and restricted
agents may plan but cannot execute.

Requires OpenCode V2 `2.0.32` exactly and Bun 1.4.2 or newer. The SDK and host
contracts are pinned to that release.

## Install

Add the npm package to the existing `plugins` list in your OpenCode configuration:

```json
{ "plugins": ["hffmnnj.goals"] }
```

When upgrading an existing installation, replace its old entry rather than
loading both. The npm package keeps the runtime ID `opencode-goals` so existing
plugin-scoped goal state remains accessible; the package name and runtime ID are
distinct. A future runtime-ID migration must preserve that state.

For local development, load the checkout by **directory path**:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-goals"
    }
  ]
}
```

Merge this entry into your existing `plugins` list; do not replace unrelated
settings, and back up the current config before editing. OpenCode reloads
watched configuration on save. A direct file path is rejected by the host ("configured
plugin path must be a directory"), so point at the checkout directory, not
`dist/index.js`. The root `index.ts` shim exists for directory loading;
`package.json` keeps the built entry at `./dist/index.js`.

Run `bun install` and `bun run build` in the checkout if `dist/index.js` is not
present yet. The plugin starts from its own location-qualified storage and does
not import or destroy state from the older `opencode-goal-plugin`. To roll back,
restore only the plugin entry from a backup; preserve unrelated configuration
changes made after that backup.

## Quick start

Use `execute` for goal bookkeeping. Code Mode tools are registered under the
`goals` namespace; discover the exact signature before calling it:

```js
search({ namespace: "goals", query: "create", limit: 1 });
return await tools.goals.create({
  objective: "Wire checkout form validation end to end",
  criteria: [
    { id: "accept", description: "Invalid input is rejected with a visible error" },
  ],
});
```

The result contains the new goal's `current.id` and `current.revision`. Pass
both back when recording evidence or changing the plan:

```js
return await tools.goals.evidence({
  goalId: "goal_<id>",
  expectedRevision: 1,
  criterionId: "accept",
  evidence: {
    summary: "Focused form test passes",
    reference: "tests/checkout.test.ts",
  },
});
```

Or create a goal from a command with `/goal create <objective>` and inspect it
with `/goal`. Each mutation returns the new revision; call `tools.goals.get`
when you need the full current state.

## Agent tools

The agent surface is the twelve Goals lifecycle operations. They are Code
Mode-only: there are no direct `goals_*` model tools, no MCP shim and no
enablement command. They derive the session, agent and cancellation signal from
the native tool context, never from agent-supplied identity, and never wake the
session on their own.

- `tools.goals.get` — full current goal, content revision, diagnostics and
  bounded archive summaries.
- `tools.goals.create` — create a goal for a substantial task. Requires an
  `objective` and at least one acceptance criterion. Does not grant work
  permissions.
- `tools.goals.revise` — revise objective or criteria using the current goal ID
  and content revision. Verified scope is preserved. `limits` and
  `sessionLimits` inputs are rejected; there is no limit setter.
- `tools.goals.plan` — replace the structured plan by default, without removing
  completed steps or evidence. Pass `mode: "append"` with only new steps to
  extend it.
- `tools.goals.evidence` — record real, reported verification evidence for one
  acceptance criterion. The plugin does not independently verify claims.
- `tools.goals.checkpoint` — record progress, evidence and the next step.
- `tools.goals.complete` — complete only after all criteria have reported
  evidence and all required work is finished.
- `tools.goals.block` — record a concrete blocker and stop automatic
  continuation.
- `tools.goals.pause` / `tools.goals.cancel` — idempotently stop future
  automation for the exact goal. Already delivered work may finish, and
  reservations are not refunded.
- `tools.goals.resume` — explicitly resume a held goal. `recover: true`
  requests same-server reconciliation, not a trusted bypass. Restricted agents
  cannot resume execution.
- `tools.goals.history` — bounded lifecycle history and archive summaries
  without waking the model.

Append new plan work without rewriting completed steps:

```js
return await tools.goals.plan({
  goalId: "goal_<id>",
  expectedRevision: 2,
  mode: "append",
  steps: [{ id: "verify", description: "Add focused verification", status: "pending" }],
  reason: "Extend plan without rewriting completed steps",
});
```

Advanced structured plans, criteria and evidence use these tools or the typed
`GoalsRPC` (id `goals`); the slash commands deliberately do not offer a
shell-like grammar for them.

## Human commands

- `/goal` and `/goal status` — inspect the current goal.
- `/goal help` — command syntax.
- `/goal history` — bounded lifecycle history.
- `/goal create <objective>` — create a goal with a full-objective acceptance
  criterion and request a guarded start. Unknown words never implicitly create
  or replace a goal.
- `/goal pause [reason]`, `/goal cancel [reason]`, `/goal clear [reason]` — stop
  future automation. `clear` is a history-preserving cancellation alias, not
  deletion.
- `/goal resume [--recover]` — ordinary resume plus a guarded start. `--recover`
  requests adapter reconciliation, not permission to bypass a safety hold.
- `/pause_goal` and `/resume_goal` — familiar aliases.

Read-only and stop commands never wake a model. On V2 2.0.32 there is no
immediate command-output surface: replies are queued passive notices (synthetic
context with `resume: false`), not already-delivered transcript messages.
Successful create/resume starts add no competing passive notice ahead of their
own admission; a failed start reports the state and diagnostics honestly through
a passive notice instead.

## Configuration

`autoContinue` defaults to `false`: the plugin keeps books but never admits an
automatic turn until automation is explicitly enabled. Bookkeeping remains
available without `api`, credentials or automation.

Full option set (`RuntimeOptionsSchema` in `src/options.ts`):

| Option | Default | Meaning |
| --- | --- | --- |
| `autoContinue` | `false` | Opt in to automatic turns after safe idle boundaries. |
| `api` | unset | Same-server loopback bridge for continuation; see below. |
| `allowAgents` | `["build"]` | Agents eligible for automatic continuation. |
| `maxNoProgress` | `2` | Consecutive non-progress observations before a hold. |
| `maxArchives` | `5` | Closed goals retained per session. |
| `maxHistory` | `100` | Lifecycle history entries retained. |
| `maxCheckpoints` | `20` | Checkpoints retained per goal. |
| `contextChars` | `6000` | Bound on injected goal context. |
| `goalLimits` / `sessionLimits` | unset | Deprecated ignored compatibility input; never used for execution or new state. |

Example automation configuration (merge into the existing plugin entry and
preserve unrelated settings):

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-goals",
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
  used unless that endpoint is proven to belong to the current process. The
  bridge never starts or switches to another server.
- A matching managed-service registration is used only when its PID is the
  process that loaded the plugin. Otherwise, Linux instances discover an
  unambiguous loopback listener held by their own process. The `/api/info` PID
  and exact `2.0.32` version are verified before any owner lock or goal record
  is accessed. Failed authentication, identity mismatch or an unreachable or
  invalid endpoint fails before ownership acquisition.
- Managed-service authentication uses that same-PID registration's private
  password; other bindings use `OPENCODE_SERVER_USERNAME` /
  `OPENCODE_SERVER_PASSWORD` (the variable names are overridable through
  `usernameEnv` / `passwordEnv`). No credential value is copied into plugin
  options, persisted goal state or diagnostics.
- Each server has matching, separate owner and storage namespaces. If the
  loading server cannot be identified safely, startup fails or degrades to
  bookkeeping-only with automation disabled; it never guesses a listener, sends
  credentials to an unverified endpoint, or shares a global goal namespace.
  After startup, inaccessible or unverified reads prevent scheduling rather
  than weakening checks. Unknown or custom execution agents default to no
  automation.

## Persistence and recovery

Goal state is durable V2 plugin storage, keyed by owner location, session and
server namespace. Each session has one current goal; closed goals remain
available as bounded archives and lifecycle history. Reloads and compaction do
not reset usage, IDs, evidence, reservations or namespaces.

Fixed goal policy lives in the system instructions. Live goal state and usage
are injected as quoted task data at the outgoing conversation tail for primary
and compaction requests; these transient blocks are not stored as user prompts.

- Reload first holds recovered active goals (`restart`) and never replays old
  input. With automation enabled, healthy observations schedule
  adapter-verified recovery at a safe native boundary. Recovery rechecks
  ownership, policy, pending work and delivery proof; missing proof remains
  held.
- Agent-requested `recover: true` during active or background work returns a
  scheduled/waiting result, not an actual resume. The runtime rechecks at an
  observed native idle boundary and may then admit one new continuation with a
  fresh ID.
- Ordinary follow-ups keep the goal active (not a manual pause), invalidate
  stale automation, and yield to new input, forms, permissions and background
  work. Background shells and children defer without charge while busy;
  correlated completion rechecks once.
- Explicit stops persist across reload. Only fresh substantive progress lifts a
  `no_progress` hold. Failed or interrupted work needs new user authorization or
  an explicit request; unknown delivery is never auto-retried.
- Reservations stay charged: there are no refunds or usage rollbacks. Legacy
  budget-paused goals stay paused until a separate explicit reconciled
  `resume`; the absence of a ceiling is not permission to auto-resume them.
- Legacy v1 envelopes remain readable and normalize to v2 without changing
  usage, high-water marks, IDs, scope, evidence, reservations or namespaces.
  The old plugin's state is never silently imported or destroyed; preserve it
  with private permissions.

## Limits and accounting

There is no turn, active-time or observed-token spending ceiling. New state uses
`schemaVersion: 2` with goal and session `limits: null` as the only current
representation; `create` and `revise` reject `limits` input and there is no
setter, default, clamp, enforcement or grant.

- Active seconds are wall-clock time while the goal's status is active, including
  idle time, not just model execution. Paused time and the restart gap are
  excluded. They are cumulative accounting, not a ceiling.
- Reload never refunds or resets persisted usage; restoring a backup is not
  permission to roll back goal state. Explicit `/goal create` and `/goal resume`
  admissions are charged to the same cumulative goal and session usage even with
  `autoContinue` off.
- Token accounting follows V2's normalized session usage: the observed total
  sums input, output, reasoning, cache reads and cache writes. Plugin observation
  is accounting only, not a provider-enforced hard cap.
- The plugin does not independently aggregate child-session usage: it charges
  what V2 reports for the bound session, not a hard total-cost cap for all
  subagents.

## Limitations

- **Same-process native API.** In `2.0.32`, `ctx.session` exposes no inbox, form
  or active-session reads and no pending-inbox cancellation, so safe scheduling
  needs the same-server bridge above. Safe process identity currently relies on
  Linux `/proc` socket ownership. When identity cannot be verified, the plugin
  fails or degrades to bookkeeping-only rather than sending credentials to an
  unverified endpoint; host-provided server identity is the preferred future integration.
- **No atomic admission (TOCTOU).** An inbox read followed by admission is not an
  atomic transaction: checks reduce but cannot eliminate the race between
  observation and admission. Already-delivered work may finish; the plugin never
  interrupts unrelated user execution, claims exactly-once execution, or
  promises instantaneous cancellation. Failed or ambiguous admissions stay
  charged, pause, and require reconciliation, never blind resubmission.
- **Passive command output.** Replies are queued synthetic context, not
  transcript replies; see Human commands.
- **No permission bypass.** Goals never approve underlying work, expand the
  user's authorization, auto-answer permission requests, switch agents, or reset
  usage. There is no spending-ceiling API, and legacy budget holds require a
  separate explicit reconciled resume. Restricted agents may plan but cannot
  execute.

## Development

Run these commands from a source checkout; development scripts and docs are not
included in the npm package.

```sh
bun install
bun run check   # typecheck, test, build
```

Reproducible native harnesses live in `scripts/` (stdlib-only Python, no new
dependencies). They spawn a private real V2 `2.0.32` server with separate
XDG/config/data/database paths and a loopback model fixture, verify the
`/api/info` PID and version, then preserve their artifact directory on exit.

```sh
python3 scripts/native-preflight.py --goals
python3 scripts/native-preflight.py --goals --command
python3 scripts/native-preflight.py --goals --resume-command
python3 scripts/native-lifecycle.py
GOALS_WATCHER_TEST=1 python3 scripts/native-lifecycle.py
```

The harnesses wait for terminal `session.execution.succeeded` outcomes; a
failed or interrupted outcome stops the run rather than retrying, matching the
plugin's own failure handling. Preflight discovers the twelve goal signatures
through Code Mode, asserts no direct `goals_*` tools reach primary model
requests, and invokes operations through `execute`.

Useful overrides: `OPENCODE_V2_BIN`, `GOALS_PLUGIN_PATH`,
`GOALS_PLUGIN_PLAIN=1`, `GOALS_SMOKE_ROOT`, `GOALS_SMOKE_TIMEOUT`,
`GOALS_WATCHER_TEST=1`, `GOALS_EXPECTED_VERSION=2.0.32` (only supported value).
Never use the default `opencode` (V1) binary or the live-config `opencodev2`
wrapper to spawn an isolated server; the scripts refuse those basenames.

Design notes and verification records, including historical pinned-host
evidence, live under `docs/`; this README describes the current `2.0.32`
contract.
