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
| Protocol v2 schemas, CBOR framing, operation/event cursors | Fork core | Stock Pi has no durable daemon command model or event-cursor contract; authoritative session-name, phase, usage, and goal changes are emitted as persisted events after runtime state transitions, while delivery failures from detached clients do not fail the operation. Compatibility is covered by `packages/server/test/v2-conformance.test.ts`. |
| V2 request-boundary type and numeric validation | Fork core | The server must reject malformed optional fields and unsafe cursors before they reach authoritative process, diagnostic, plan, plugin, filesystem, web, or image state; a client-side extension cannot enforce this for every client. Compatibility is covered by `packages/server/test/v2-conformance.test.ts`. |
| Session attachment authorization for server-owned projections and tools | Fork core | Only the daemon connection owns attachment and control leases, so client-side checks cannot prevent an untrusted connection that knows a session, operation, agent, plan, goal, filesystem, web, or image identifier from bypassing the server boundary. Compatibility is covered by the observer/no-attachment cases in `packages/server/test/v2-conformance.test.ts`. |
| Remote snapshot and event-boundary validation | Fork core | A detached client must reject stale or malformed server state at the protocol boundary; a client-side extension cannot make authoritative cursor ordering, recovery snapshots, and typed event payloads safe. Compatibility is covered by the remote v2 session recovery, cursor, event, and response-validation fixtures. |
| Server daemon lifecycle, leases, reconnect, and platform transport (Unix sockets / Windows named pipes) | Fork core | A client-only extension cannot own process lifecycle, authentication, reconnect recovery, or the server-owned cross-platform byte transport. |
| Durable daemon lifecycle and crash-recovery markers | Fork core | The stock extension surface has no authoritative daemon-generation boundary or durable clean-shutdown state; startup must classify unclean ownership and expose that decision through server diagnostics. |
| Server-default RPC compatibility bridge | Fork core | Normal CLI RPC must enter the daemon-owned session boundary for durable state and operation ownership; the legacy direct RPC entry point remains available for v1 compatibility. |
| Server-runtime extension host and frozen operation model context | Fork-dependent extension | Durable server hooks need lifecycle callbacks, explicit server/client/both scope, bounded capability metadata, and state access outside the client UI host; the accepted operation must carry its resolved model so terminal callbacks cannot observe a later model switch. Compatibility is covered by `packages/coding-agent/test/server/extension-host.test.ts` and the V2 service lifecycle fixtures. |
| SQLite coding-agent service and durable session runtime | Fork-dependent extension | The existing harness is reusable, but it needs a server-owned session adapter and persistent operation boundary. |
| Critical diagnostics, encrypted capsules, and offline verification | Fork core | Causal evidence and atomic acceptance require the authoritative server and persistence paths. |
| Diagnostic doctor integrity isolation and safe SQLite repair | Fork core | Diagnostics must remain available when an integrity provider fails, and only the daemon-owned canonical repository can safely rebuild derived branch caches or report SQLite schema/quick-check state; a client extension cannot enforce that repair boundary. Compatibility is covered by the server doctor conformance tests and configured daemon doctor assertions. |
| Protocol command forensic spans | Fork core | Only the server transport boundary can correlate every request outcome with its connection, session, and operation identity without exposing command payload content. |
| Daemon-generation correlation on V2 evidence | Fork core | The daemon owns restart identity while the V2 server owns protocol effects; threading the generated identity through the transport is required to explain evidence across a daemon generation. |
| Client diagnostic identity handoff | Fork core | The V2 hello manifest must carry the client spool identity so merged offline evidence can attribute local records without relying on payload content or ambient process state. |
| Rotating operational diagnostic log | Fork core | Server-mode diagnostics must retain a bounded structured-log window for timing and pre-session failures while canonical forensic persistence remains authoritative; an optional sink cannot enforce this daemon boundary by itself. |
| Rotating client diagnostic spool | Fork core | Client boot, render, and pre-connect failures need a retained local evidence window that can be merged into server bundles; a single rewritten spool cannot preserve bounded history across rotations. |
| SQLite maintenance inspection and backup | Fork core | Durable session state needs an online consistent snapshot, schema-version report, and integrity verification owned by the canonical repository; ad hoc file copies cannot safely capture a WAL database. |
| Processes, files, blobs, web, images, plans, and structured input | Fork-dependent extension | These are provider-neutral server adapters exposed through v2; their ownership must remain outside the TUI. |
| Cross-model child-agent graph and scheduling | Fork-dependent extension | The existing agent APIs do not provide daemon-owned graph identity, leases, or remote lifecycle events. |
| Codex plugin and marketplace compatibility | Stock-compatible extension | Manifest parsing, acquisition, activation, and sampling can use adapter boundaries without changing provider APIs. |
| Goals, rollback, usage, and cost projections | Fork core | Durable budgets, append-only rollback, and authoritative accounting must be committed with session state. |
| Remote TUI views and interactive adapter | Fork-dependent extension | Existing TUI components can render server snapshots, but remote leases, controls, and live name/phase/usage/goal projections require a v2 client adapter. |
| Server-default SDK session factory | Fork-dependent extension | The public SDK needs a daemon-owned lifecycle and V2 remote session while preserving the direct runtime factory as an explicit compatibility escape hatch; coverage is provided by `packages/coding-agent/test/client/server-sdk.test.ts`. |
| Session naming, statusline, and migration tooling | Stock-compatible extension | These consume public model, harness, and TUI seams; no protocol change is required. |
| Runtime build identity in diagnostics | Fork core | A diagnostic bundle must identify the fork build and pinned upstream base; stock runtime metadata has no fork-owned release identity boundary. |

## Runtime identity metadata

Configured daemon builds read release metadata from `PI_BUILD_VERSION`,
`PI_FORK_COMMIT`, `PI_UPSTREAM_BASE_COMMIT`, and `PI_CONFIG_HASH`. Release and
CI jobs must inject the first three values so exported diagnostic bundles can
be attributed to an exact fork build and upstream base; local development may
omit them and retains only host/runtime identity. Standalone builders normalize
the conventional leading `v` from `RELEASE_TAG`, preserve explicit
`PI_BUILD_VERSION`, derive archive identity from the selected Git ref, and
encode generated literals safely before compilation. The runtime-manifest
contract test protects blank-environment fallback to compiled identity.

## Update policy

Every new fork-core change must add or refine one ledger row with the
extension insufficiency and the compatibility test that protects the boundary.
Reusable adapters should remain isolated from private Pi internals so they can
be proposed upstream independently.
