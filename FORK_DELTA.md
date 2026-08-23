# apohl79/pi fork-delta ledger

This ledger records why the Codex-fork implementation changes the fork-owned
surface instead of relying on an upstream extension. It is maintained on the
fork's `main` integration branch and is updated whenever a new fork-core
boundary is introduced.

## Baseline and remotes

- Authoritative integration and release repository: `apohl79/pi`.
- Initial pinned upstream base: `5cd93f688aaab89dbb6dfa4aca535f21796ae185`.
- `origin`: `https://github.com/apohl79/pi`.
- `upstream`: `https://github.com/earendil-works/pi`.
- Stacked feature branches are fork-owned and are merged manually in base-chain order.

## Classification rules

- **Stock-compatible extension**: uses existing public Pi interfaces and can be
  removed or upstreamed without changing the stock server or harness contract.
- **Fork-dependent extension**: adds a reusable adapter or package, but needs
  the fork's v2 protocol or daemon seam to be useful.
- **Fork core**: changes authoritative state, protocol, transport, recovery, or
  process ownership because the existing extension surface cannot provide the
  required guarantee.

## Current delta

| Area | Classification | Why the existing surface is insufficient |
| --- | --- | --- |
| Protocol v2 schemas, CBOR framing, operation/event cursors | Fork core | Stock Pi has no durable daemon command model or event-cursor contract. |
| Server daemon lifecycle, leases, reconnect, and platform transport (Unix sockets / Windows named pipes) | Fork core | A client-only extension cannot own process lifecycle, authentication, reconnect recovery, or the server-owned cross-platform byte transport. |
| Durable daemon lifecycle and crash-recovery markers | Fork core | The stock extension surface has no authoritative daemon-generation boundary or durable clean-shutdown state; startup must classify unclean ownership and expose that decision through server diagnostics. |
| Server-default RPC compatibility bridge | Fork core | Normal CLI RPC must enter the daemon-owned session boundary for durable state and operation ownership; the legacy direct RPC entry point remains available for v1 compatibility. |
| SQLite coding-agent service and durable session runtime | Fork-dependent extension | The existing harness is reusable, but it needs a server-owned session adapter and persistent operation boundary. |
| Critical diagnostics, encrypted capsules, and offline verification | Fork core | Causal evidence and atomic acceptance require the authoritative server and persistence paths. |
| Protocol command forensic spans | Fork core | Only the server transport boundary can correlate every request outcome with its connection, session, and operation identity without exposing command payload content. |
| Daemon-generation correlation on V2 evidence | Fork core | The daemon owns restart identity while the V2 server owns protocol effects; threading the generated identity through the transport is required to explain evidence across a daemon generation. |
| Processes, files, blobs, web, images, plans, and structured input | Fork-dependent extension | These are provider-neutral server adapters exposed through v2; their ownership must remain outside the TUI. |
| Cross-model child-agent graph and scheduling | Fork-dependent extension | The existing agent APIs do not provide daemon-owned graph identity, leases, or remote lifecycle events. |
| Codex plugin and marketplace compatibility | Stock-compatible extension | Manifest parsing, acquisition, activation, and sampling can use adapter boundaries without changing provider APIs. |
| Goals, rollback, usage, and cost projections | Fork core | Durable budgets, append-only rollback, and authoritative accounting must be committed with session state. |
| Remote TUI views and interactive adapter | Fork-dependent extension | Existing TUI components can render server snapshots, but remote leases and controls require a v2 client adapter. |
| Session naming, statusline, and migration tooling | Stock-compatible extension | These consume public model, harness, and TUI seams; no protocol change is required. |
| Runtime build identity in diagnostics | Fork core | A diagnostic bundle must identify the fork build and pinned upstream base; stock runtime metadata has no fork-owned release identity boundary. |

## Runtime identity metadata

Configured daemon builds read release metadata from `PI_BUILD_VERSION`,
`PI_FORK_COMMIT`, `PI_UPSTREAM_BASE_COMMIT`, and `PI_CONFIG_HASH`. Release and
CI jobs must inject the first three values so exported diagnostic bundles can
be attributed to an exact fork build and upstream base; local development may
omit them and retains only host/runtime identity.

## Update policy

Every new fork-core change must add or refine one ledger row with the
extension insufficiency and the compatibility test that protects the boundary.
Reusable adapters should remain isolated from private Pi internals so they can
be proposed upstream independently.
