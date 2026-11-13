# Native Code Mode goal tools

## Change and preserved boundaries

All 12 goal operations now use native V2 tool options `{ namespace: "goals", codemode: true }`. They are searchable and callable as `tools.goals.*` inside `execute`, not separate direct `goals_*` model tools. No MCP wrapper, dependencies, pinning, permission gate or compatibility toggle was added. Native registration still supplies the Code Mode catalog and the original per-call session, agent and AbortSignal. RPC, slash-command routing, storage, budgeting, ownership and recovery logic are unchanged.

Policy, continuation text, truncation notices, command guidance and mutation `inspect` hints now point to Code Mode (`tools.goals.get`). This last field is a public inspection hint, not a persisted-state migration. Current usage examples are in the [README](../README.md#agent-tools).

The implementation follows the pinned `@opencode/schema` 2.0.25 `Tool.Options` and installed native plugin examples, cross-checked against the V2 plugin guide. The root loader shim remains required. No direct fallback is used if Code Mode fails.

## Coordinator verification

- Full local check: strict types passed; **151 tests passed, 0 failed, 1,159 assertions**; build passed. The expanded real-runtime registration test checks exactly 12 unique Code Mode tools, schema binding, context-derived session/agent/signal, real create/get results, spoofed input rejection, aborted calls, no model wake and disposed-executor fencing. The implementation worker observed the false-flag fault fail this contract assertion, then restored the true flag and reran green.
- Watcher lifecycle scenario: **18 checks**, all 12 RPC methods, passive commands, retained append/evidence, restart and watched reload passed.
- Coordinator reran the revised shipped preflight against private real V2 **2.0.25** hosts:

| Scenario | Provider calls | Successful native executions |
| --- | ---: | ---: |
| `--goals` | 10 | 2 |
| `--goals --command` | 5 | 1 |
| `--goals --resume-command` | 5 | 1 |

Each scenario discovers exactly all 12 paths with callable signatures, verifies required public inputs and no trusted identity/accounting inputs, and asserts `execute` is present and direct `goals_*` tools absent from every primary model request. Actual operations run through `execute`. The automatic case verifies agent creation, append preserving completed work and evidence, stale-revision rejection with unchanged state, checkpoint, automatic continuation, criterion evidence and completion. Command cases verify guarded starts with automation disabled and no competing passive notice. These use a scripted local provider, not external-model judgment; only a subset of lifecycle operations is invoked through Code Mode, while all 12 have registration/schema checks and separate native RPC coverage.

## Discovery diagnostic and maintainability

The initial all-signature discovery probe exceeded native output bounds (observed truncation near 95 KB); the failed evidence was retained. The harness now returns the shared result signature once, checks that each entry shares it, and reconstructs full signatures in its artifact. No operation or catalog entry is discarded. Agents should search the needed operation, as the README's `query`/`limit: 1` example does, rather than dump every large schema.

Coordinator review removed a redundant full copy of the TypeScript schema printer from the harness. Discovery checks protect paths, required inputs, append mode, trusted-field absence and success/error result descriptions without pinning property order, deeply nested `unknown` rendering or every printed constraint. Existing public-schema tests protect validation, and real native calls protect compatibility. The three native scenarios above passed after this simplification.

## Installed behavior

A native `execute` search in the installed environment returned all **12** `tools.goals.*` paths, zero remaining, and a valid `tools.goals.get()` signature. A real `await tools.goals.get()` returned the existing cancelled goal in full view with observing runtime diagnostics. Its old goal ceiling and old session ceiling remained intact. No goal was created, resumed or reset for this live inspection. Discovery separately confirmed plan `mode: "append"` remains advertised.

Live inventory verified the replacement active with all three slash commands in **all loaded locations**, legacy absent everywhere, and all owner records still belonging to the foreground process. The managed process remained alive. No global configuration change was needed for Code Mode; the local built package was observed reloaded. Matching budget options and every unrelated configuration field and plugin remained preserved.

As with any plugin update, a previously captured executor may reject after disposal; do not forward stale mutations into a replacement runtime. The three prior unrelated [verification findings](feature-verification.md) remain open. No server restart, location eviction, manual ownership change, form/permission reply, CI or exhaustive-correctness claim is part of this change.
