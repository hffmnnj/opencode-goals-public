# Goals-only plugin restoration

## Objective

Remove the Workboard/state-manager integration from `opencode-goals`, retain its
standalone native Goals functionality, and re-enable it in the existing OpenCode
V2 configuration.

## Scope and constraints

- Remove the board-specific passive telemetry/RPC surface and its unused support
  code, without changing the twelve native Goals lifecycle operations.
- Preserve Goals storage, usage accounting, plans, evidence, commands, continuation
  safeguards, ownership, and server-binding checks.
- Retain historical verification documents as historical records, clearly marking
  superseded integration documentation where appropriate.
- Build and verify the plugin before restoring its configuration entry. Preserve
  unrelated configuration and take reversible backups of activation files.
- Prefer the existing watched configuration/plugin reload. Do not restart services,
  modify stored goals, delete owner files, or change the separate Workboard/state
  manager application.
- This existing plugin directory is not a Git checkout. Do not initialize or
  publish a new repository as part of this local restoration.
- At discovery the running host was V2 `2.0.32`, while the plugin pinned `2.0.25`.
  Audit the used native contracts and admit only an explicitly verified version;
  preserve all same-process identity/authentication checks. Exercise the existing
  isolated native lifecycle and continuation harnesses on the running release
  before activation; do not replace the version guard with a broad range.

## Compatibility decision

The exact-version contract audit found the used native session, storage,
tools, commands, RPC, and loopback endpoint contracts compatible with `2.0.32`.
Both SDK dependencies must also move to `2.0.32`: their Effect runtime changed,
and the current Promise adapter eagerly accesses a credential domain absent
from the old host. The restored build therefore supports **only `2.0.32`**, with
one shared exact-version constant for bridge and managed registration checks.
Retaining `2.0.25` in an allowlist would promise unverified backward compatibility.
All PID, local-file security, socket ownership, authentication, and namespace
checks remain unchanged. Current native acceptance harnesses target `2.0.32`;
other historical harnesses remain explicitly outside current acceptance evidence.

## Acceptance checks

1. Source, registered RPCs, and the built runtime expose Goals only: the twelve
   existing lifecycle operations remain, and the board-specific snapshot API is
   absent.
2. Focused behavior tests, type checking, the complete relevant plugin test suite,
   and a fresh build pass.
3. User-facing documentation describes standalone Goals and the removal; retained
   integration history is explicitly superseded.
4. The active V2 configuration loads the rebuilt local plugin with native Goals
   options only, without unrelated configuration changes or obsolete ceilings.
5. Read-only runtime evidence confirms activation when available, without a restart
   or calls that alter actual goal state. Record exact tested and untested scope.

## Workstreams

Source simplification, behavior-test updates, and documentation are separate file
ownership slices. The coordinator owns this specification, roadmap, build,
configuration restoration, and activation; independent verification follows
integration.
