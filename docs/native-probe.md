# Native V2 2.0.25 probe

An isolated real OpenCode V2 server was run with a tiny native RPC plugin, two separate location directories and a dedicated database. The harness and results were retained privately. The server was terminated after each run; the production server was not restarted.

Successful run: the native probe script against the isolated host on 2026-10-14; full result was retained with the harness.

## Verified behavior

- Two locations instantiate the plugin separately (different instance UUIDs).
- **`ctx.storage` is shared across those locations for the same plugin ID.** A value written under `same-key` in location A was read in location B. Keys must include location ownership; scanning every stored goal from every instance would be unsafe.
- Native `ctx.session` methods are exactly hook/create/get/remove/switchAgent/switchModel/prompt/generate/command/compact/synthetic/interrupt/update/move/wait/context. It has **no inbox, form or active-session list APIs** in 2.0.25.
- Native `ctx.permission` exposes hook/list/get/reply.
- Use bare host imports `@opencode/plugin` and `@opencode/plugin/rpc`. Importing the package's absolute `dist` internals is rejected by the plugin loader.
- In the pinned 2.0.25 RPC contract, `events` and per-method `input`/`output` are required despite current online documentation showing optional input/output. Explicit schemas are needed.
- RPC output must be JSON-compatible. Returning full host schema class instances or object properties with `undefined` fails output validation. Return plain, explicitly serialized data.
- Native command admission uses HTTP `{ name, text }` in 2.0.25, not the current documentation's `{ command, arguments }` example.
- An actual passive command using `session.synthetic({ resume: false })` created an undelivered synthetic inbox notice, left `session.context` empty and left `session.active` empty. It does **not** immediately append transcript output. Document notices as queued status information; do not pretend they are synchronous transcript messages. A supported server-only command has no direct UI/toast output callback.
- Foreground `serve` supplies connection credentials in startup output. The isolated harness reads those without logging their value. Initial Basic-auth username/password assumptions were rejected; test credentials and live-service credentials must not be conflated. A separate authenticated check confirmed the foreground service accepts the existing local credentials; a managed-service registration password was not accepted by that foreground service.

## Cleanly diagnosed probe failures

Initial probes rejected incorrect auth assumptions (401), private package imports (load rejection), missing RPC `events`/output schema (load error), and host class output (rpc.invalid_output). Each was diagnosed against logs/types and corrected, rather than bypassing validation. Credentials are ephemeral, never included in result.json, and startup log credentials are redacted by the final harness.

## Runtime implication

Native bookkeeping can work entirely through `ctx`. Safe automatic continuation needing pending-input/form checks and plugin-owned inbox withdrawal must use an explicit trusted same-server bridge or remain disabled. Never discover/start an unrelated service just to obtain these methods. Verify the bridge's process identity against the plugin process and preserve native session/location authority.

## Deterministic native model/tool preflight

The native preflight script passed against another isolated V2 2.0.25 instance. A local OpenAI-compatible SSE protocol fixture caused a real native tool execution and a successful native execution outcome across two model requests. This tests the acceptance harness without external model cost or user credentials; it is not yet a test of the goals implementation. The result artifact was retained privately.

The follow-up also resolved authentication precisely: setting `OPENCODE_SERVER_PASSWORD` supplies the foreground password and suppresses printing it. Native Basic-auth username is `opencode`. The harness now supplies a private random password and waits for the listening marker rather than expecting a password line. A separate authenticated check confirmed the existing local environment can authenticate the live server.
