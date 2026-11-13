# Installed legacy integration audit

Read-only audit on 2026-10-14, completed by an independent explorer. Findings below are integration inputs, not approval to remove data.

## Active setup

- V2 configuration: `<opencode-config>/opencode.json`.
- Old plugin: `@prevalentware/opencode-goal-plugin`, installed version **0.1.60**, unpinned configuration entry.
- Installed package root: under the V2 npm cache for the old package. Source includes `dist/server.js`, `src/tui.ts`, `src/state-path.ts`, README and license. The installed server is a bundle; source string surveys are not proof of full implementation behavior.
- State path selected by `OPENCODE_GOAL_STATE_PATH`, otherwise `$XDG_DATA_HOME/opencode-goal-plugin/goals.json`.
- Live state was observed at the XDG data location, mode `0600`, version 3, with existing active records. Do not destroy or silently continue/import them.
- Old tools include create/set/get/history/list/update/objective/status/plan/stop/replace/clear. Old policies require explicit user authorization for goal creation and lifecycle changes; the replacement removes that bookkeeping restriction while retaining ordinary work permissions.
- Old slash commands: `/goal`, `/pause_goal`, `/resume_goal`.

## Runtime selection correction

Use the installed V2 launcher for this live setup. It supplies isolated V2 XDG paths, database selection, server credentials and explicit foreground service routing. Directly invoking the release binary without those variables can discover a different managed service and is insufficient installation evidence.

The live web service listened on a loopback port, with PWA edge routing on an adjacent loopback port. A read-only `opencodev2 api get /api/info` check confirmed V2 **2.0.25** at the time. Never hardcode these ephemeral values in plugin implementation.

## Replacement and rollback

1. Read current configuration immediately before editing; preserve unrelated and concurrent changes.
2. Back up the exact current configuration and legacy state using private permissions.
3. Replace only the old plugin entry with the new local package path. Do not delete its npm cache, state or unrelated integration files.
4. Verify new load and old deactivation against the actual V2 service, not only a generic CLI inventory.
5. Keep an explicit rollback description. Configuration restoration must merge only the plugin entry if unrelated user changes occur after backup.

A global reload affects all locations and cancels pending forms/permissions. Avoid restarting the server running this work merely to refresh tools; prefer isolated acceptance, watcher-driven refresh and a final deliberate activation check.

## Out-of-scope findings

The existing configuration contained a plaintext authorization header and broad global permissions. Do not expose secret values or change unrelated security configuration in this task. File-plugin dependency versions varied; the new plugin should pin `@opencode/plugin` to the tested **2.0.25** API rather than follow `latest` (2.0.29 at audit time).
