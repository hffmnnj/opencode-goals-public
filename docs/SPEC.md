# Cache-stable goal context

Goal: preserve live goal state, cumulative usage, continuation and every safety check without changing the fixed system prefix on every model step.

Not doing: no functionality removal, auth changes, storage migration, new service, spending ceiling, or OpenCode restart.

Acceptance checks:
1. Fixed goal policy remains system instructions; changing quoted goal state is supplied at the conversation tail for primary and compaction requests.
2. Token/time updates change the live quoted state without changing existing system or history bytes.
3. Goals tools, slash commands, pause/cancel, permission checks and automatic continuation retain their behavior.
4. Request construction is idempotent, preserves native message types and tool/result adjacency, and never mutates durable history.
5. Focused regression tests, typecheck and a non-destructive build pass without provider calls.
