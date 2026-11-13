# OpenCode V2 contract research

Target verified on 2026-10-14: OpenCode **2.0.25**. The default shell `opencode` resolved to a separate V1 installation and must not be used for this plugin's V2 verification. The V2 release executable is installed under the V2 CLI release directory for the pinned version.

Initial direct-binary service discovery and OpenAPI reads succeeded but referred to a separate managed instance. The foreground V2 service was reached through the installed V2 launcher (loopback edge on an adjacent port, actual server on the configured loopback port); installation acceptance must use that launcher, not the separately discovered managed service. A running-server OpenAPI snapshot was retained privately for research.

## Primary documentation read

- [Plugin API](https://opencode.ai/v2/docs/build/plugins): `Plugin.define`, `setup`, domain transforms, session/tool hooks and durable `ctx.storage`.
- [Plugin loading](https://opencode.ai/v2/docs/plugins): local paths supported; plugin arrays accumulate; changes under watched config locations reload, while external dependencies may need explicit reload/restart.
- [RPC](https://opencode.ai/v2/docs/build/plugins/rpc): shared contract with validated methods/events; HTTP `POST /api/rpc/{rpcID}/{method}` accepts `{ "input": ... }` and returns `{ "output": ... }`.
- [Client](https://opencode.ai/v2/docs/build/client): Promise API and live-only, non-replaying event subscriptions. Consumers must buffer before doing slow work. Source failure ends subscriptions; recovery requires a new subscription.
- [Configuration](https://opencode.ai/v2/docs/config): preserve unrelated settings and use `plugins` array entries, not V1 API shapes.
- [HTTP API](https://opencode.ai/v2/docs/api): session prompt, synthetic, inbox, context, interrupt and location reload routes.

## Design implications

1. Register agent tools and slash commands natively, backed by one service rather than prompt-only commands or a separate MCP process.
2. `context` hooks run before every agent-loop model call; use them for a fresh bounded goal snapshot. `compaction` hooks can retain goal orientation without replacing OpenCode's compaction result.
3. Installed OpenAPI clarifies that both `session.prompt` and `session.synthetic` durably admit input and schedule execution **unless `resume: false`**. Status output must set `resume: false`; continuation must deliberately choose its admission type. Both endpoints accept a caller-supplied message `id`, metadata, delivery and resume controls.
4. Use plugin-scoped durable storage and serialize state updates within a runtime. Storage has get/set/scan/remove but no documented compare-and-swap or transaction API; do not claim cross-process linearizability without a separate mechanism.
5. Session info exposes cumulative `tokens` and `cost`, selected `agent`, `location`, `outcome`, and `time.idle`. Track an explicit goal baseline and reconcile rather than guessing usage from text.
6. Idle messages carry `outcome: succeeded | failed | interrupted`. An interrupt or provider failure is not successful completion and must never trigger a blind retry loop.
7. Agent info exposes ordered `permissions`, but no universal read-only flag. Restricted-agent handling must account for configured permission rules and document the policy.
8. Keep tool permissions intact. Permission hooks must not auto-approve work just because a goal exists. Agent-first authority applies to bookkeeping, not escalation of filesystem/network privileges.
9. Context contains user task data, not new authority. Goal fields, plans, checkpoints and evidence must be clearly delimited and never injected as executable instructions overriding session policy.
10. Installed `@opencode/schema/dist/token-usage.js:12–13` defines total as **input + output + reasoning + cache.read + cache.write**. In the AI usage representation, raw output includes reasoning, but `@opencode/ai/dist/schema/events.js:67–73` derives text output by subtracting reasoning. Do not conflate raw provider usage with normalized session usage. The plugin follows V2's normalized total and includes caches, unlike Codex's uncached-input + output goal units.
11. Pinned `Tool.Options` supports `codemode: true` with a namespace and optional pinning. The goal tools use `{ namespace: "goals", codemode: true }` without pinning: native Code Mode discovery exposes `tools.goals.*`, while direct `goals_*` model tools are absent. The original executor receives the calling context unchanged. Actual search/execute, commands and continuation were verified in `codemode-verification.md`; no MCP process or RPC-to-tool identity shim is required.

## Verification performed

- V2 `service status`: healthy endpoint.
- V2 `api get /api/info`: returned version `2.0.25`.
- V2 `api get /openapi.json`: valid JSON, 272869 bytes; inspected `Session.Info`, `Session.Message.Idle`, `Session.Message.Assistant`, `TokenUsage.Info`, `Agent.Info`, and `Session.Inbox.SyntheticPayload` schemas.

This is contract research, not evidence that the new plugin is implemented or installed.

## Admission and reload details from installed OpenAPI

- `session.inbox.list` returns enqueued, undelivered user, synthetic, compaction and move entries in enqueue order. Use it to yield to user/control work; an empty result alone is not an atomic admission lock.
- `session.interrupt` accepts query parameter `resume`; installed clients may expose a differently named semantic field, so compile against the pinned package. Do not assume a documentation example exactly matches generated client arguments.
- `location.reload` shuts down and rebuilds **every loaded location**, cancels pending permissions/forms, and resumes running sessions with fresh services at the next step boundary. It is not a harmless location-local refresh. Avoid unnecessary live reloads on the user's main service; prefer isolated acceptance first.

## Actual 2.0.25 host differences found by integration

- Configuring the directory with package exports alone did not discover the built plugin. A root `index.ts` re-export of `./dist/index.js` is required by the tested directory loader. A configured direct file path logged `configured plugin path must be a directory`, despite current online documentation permitting file paths. Do not remove the shim or substitute a direct-file install without retesting the installed release.
- `ctx.event.subscribe` exposes numeric event timestamps. Execution lifecycle and usage events omit location; durable step/inbox events include it. Validate actual session ownership rather than assuming every event carries a location.
- Real successful execution emitted `session.execution.succeeded`, **not** `session.idle`. The idle message is persisted before that terminal event. Scheduling must correlate a fresh successful execution, native quiescence, the latest idle message and `session.time.idle`, rather than relying on a nonexistent event or reversing their timestamp order.
- A watched global config options change emitted `config.updated` and ultimately `plugin.updated`, not `location.shutdown`. The native test verified old ownership was disposed, the plugin remained active and the persisted active goal reopened paused for restart. This is distinct from explicitly calling the all-location `location.reload` API.
- Native inbox metadata is under `item.payload.metadata`; top-level `item.metadata` is not the wire shape. Passive synthetic notices remain pending and do not append transcript messages by themselves.

These findings come from isolated real-server tests, not simulated adapter events. Evidence and remaining acceptance work are recorded in `verification.md`.
