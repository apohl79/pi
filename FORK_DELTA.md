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
| Protocol v2 schemas, CBOR framing, operation/event cursors | Fork core | Stock Pi has no durable daemon command model or event-cursor contract; authoritative operation-running, session-name, phase, usage, goal, compaction-policy, and instruction-profile changes are emitted as persisted events after runtime state transitions, while delivery failures from detached clients do not fail the operation. Compatibility is covered by `packages/server/test/v2-conformance.test.ts`. |
| V2 request-boundary type and numeric validation | Fork core | The server must reject malformed optional fields and unsafe cursors before they reach authoritative process, diagnostic, plan, plugin, filesystem, web, or image state; a client-side extension cannot enforce this for every client. Compatibility is covered by `packages/server/test/v2-conformance.test.ts`. |
| Session attachment authorization for server-owned projections and tools | Fork core | Only the daemon connection owns attachment and control leases, so client-side checks cannot prevent an untrusted connection that knows a session, operation, agent, plan, goal, filesystem, web, or image identifier from bypassing the server boundary. Compatibility is covered by the observer/no-attachment cases in `packages/server/test/v2-conformance.test.ts`. |
| Remote snapshot and event-boundary validation | Fork core | A detached client must reject stale or malformed server state at the protocol boundary; a client-side extension cannot make authoritative cursor ordering, recovery snapshots, and typed event payloads safe. Compatibility is covered by the remote v2 session recovery, cursor, event, and response-validation fixtures. |
| Server daemon lifecycle, leases, reconnect, and platform transport (Unix sockets / Windows named pipes) | Fork core | A client-only extension cannot own process lifecycle, authentication, reconnect recovery, or the server-owned cross-platform byte transport. Compatibility is covered by `packages/server/test/unix.test.ts` and remote reattach production tests. |
| Durable daemon lifecycle and crash-recovery markers | Fork core | The stock extension surface has no authoritative daemon-generation boundary or durable clean-shutdown state; startup must classify unclean ownership and expose that decision through server diagnostics. Compatibility is covered by `packages/coding-agent/test/server/daemon-agent-restart.test.ts`. |
| Server-default RPC compatibility bridge | Fork core | Normal CLI RPC must enter the daemon-owned session boundary for durable state and operation ownership while preserving prompt follow-up semantics, operation acknowledgement ordering, session-name validation, and new-session parent provenance; the legacy direct RPC entry point remains available for v1 compatibility. Compatibility is covered by the server-default RPC production fixtures. |
| Server-runtime extension host and frozen operation model context | Fork-dependent extension | Durable server hooks need lifecycle callbacks, explicit server/client/both scope, bounded capability metadata, and state access outside the client UI host; the accepted operation must carry its resolved model so terminal callbacks cannot observe a later model switch. Compatibility is covered by `packages/coding-agent/test/server/extension-host.test.ts` and the V2 service lifecycle fixtures. |
| Pi-native sampling adapter and compatibility diagnostics | Fork-dependent extension | Pi's request-only sampling registrations can be reused through a server-scoped adapter, but process-local tools, commands, renderers, and lifecycle handlers cannot safely execute in a detached daemon without a server context; configured startup therefore discovers extensions, adapts sampling, and records bounded incompatibility warnings. Compatibility is covered by `packages/coding-agent/test/server/pi-extension-adapter.test.ts` and the configured-daemon discovery fixture. |
| SQLite coding-agent service and durable session runtime | Fork-dependent extension | The existing harness is reusable, but it needs a server-owned session adapter and persistent operation boundary. Compatibility is covered by `packages/coding-agent/test/server/sqlite-service.test.ts` and production daemon runtime fixtures. |
| Durable steer/follow-up queue delivery and disposition | Fork core | Queue admission, provider-loop consumption, canonical transcript projection, and consumed-versus-cancelled reporting must share the harness/session mutation boundary; a client extension cannot make detached queue state or cancellation races authoritative. Compatibility is covered by the AgentHarness faux-provider queue regression and remote follow-up production fixture. |
| Critical diagnostics, encrypted capsules, and offline verification | Fork core | Causal evidence and atomic acceptance require the authoritative server and persistence paths. Compatibility is covered by `packages/server/test/diagnostics.test.ts`. |
| Diagnostic doctor integrity isolation and safe SQLite repair | Fork core | Diagnostics must remain available when an integrity provider fails, and only the daemon-owned canonical repository can safely rebuild derived branch caches or report SQLite schema/quick-check state; a client extension cannot enforce that repair boundary. Compatibility is covered by the server doctor conformance tests and configured daemon doctor assertions. |
| Server-owned diagnostic, connector, store, and bundle event notifications | Fork core | These transition and progress notifications originate at the daemon boundary and must reach attached clients without making client-local UI state authoritative; client extensions cannot guarantee server ordering, detached-session replay, or redaction. Compatibility is covered by v2 event conformance fixtures and remote-session transient-event tests. |
| Protocol command forensic spans | Fork core | Only the server transport boundary can correlate every request outcome with its connection, session, and operation identity without exposing command payload content. Compatibility is covered by `packages/server/test/v2-conformance.test.ts`. |
| Daemon-generation correlation on V2 evidence | Fork core | The daemon owns restart identity while the V2 server owns protocol effects; threading the generated identity through the transport is required to explain evidence across a daemon generation. Compatibility is covered by `packages/coding-agent/test/client/remote-v2-production-diagnostics.test.ts`. |
| Client diagnostic identity handoff | Fork core | The V2 hello manifest must carry the client spool identity so merged offline evidence can attribute local records without relying on payload content or ambient process state. Compatibility is covered by `packages/coding-agent/test/client/remote-v2-production-diagnostics.test.ts`. |
| Rotating operational diagnostic log | Fork core | Server-mode diagnostics must retain a bounded structured-log window for timing and pre-session failures while canonical forensic persistence remains authoritative; an optional sink cannot enforce this daemon boundary by itself. Compatibility is covered by `packages/server/test/diagnostics.test.ts`. |
| Rotating client diagnostic spool | Fork core | Client boot, render, and pre-connect failures need a retained local evidence window that can be merged into server bundles; a single rewritten spool cannot preserve bounded history across rotations. Compatibility is covered by `packages/coding-agent/test/client/remote-v2-production-diagnostics.test.ts`. |
| SQLite maintenance inspection and backup | Fork core | Durable session state needs an online consistent snapshot, schema-version report, and integrity verification owned by the canonical repository; ad hoc file copies cannot safely capture a WAL database. Compatibility is covered by `packages/coding-agent/test/server/daemon-runtime.test.ts`. |
| Processes, files, blobs, web, images, plans, and structured input | Fork-dependent extension | These are provider-neutral server adapters exposed through v2; their ownership must remain outside the TUI. Compatibility is covered by server adapter tests and production remote files, web/image, plan, and input fixtures. |
| Cross-model child-agent graph and scheduling | Fork-dependent extension | The existing agent APIs do not provide daemon-owned graph identity, leases, or remote lifecycle events. Compatibility is covered by `packages/server/test/agents.test.ts` and `packages/coding-agent/test/server/daemon-agents.test.ts`. |
| Codex plugin and marketplace compatibility | Stock-compatible extension | Manifest parsing, acquisition, activation, and sampling can use adapter boundaries without changing provider APIs. Compatibility is covered by Codex plugin package tests and production plugin lifecycle/sampling fixtures. |
| Goals, rollback, usage, and cost projections | Fork core | Durable budgets, append-only rollback, and authoritative accounting must be committed with session state. Compatibility is covered by the remote goal, rollback, and usage production tests. |
| Remote TUI views and interactive adapter | Fork-dependent extension | Existing TUI components can render server snapshots, but remote leases, controls, live name/phase/usage/goal/compaction/instruction projections, and server-owned active agent paths require a v2 client adapter. Compatibility is covered by remote interactive/session fixtures and TUI contract tests. |
| Harness structural lifecycle events | Fork core | Compaction, tree navigation, and item/tool lifecycle are server-owned durable operations; the stock harness event surface does not expose their accepted run ID, reason, terminal outcome, or bounded item/tool status after persistence. Compatibility is covered by the AgentHarness lifecycle tests and v2 runtime event conformance. |
| Server-default SDK session factory | Fork-dependent extension | The public SDK needs a daemon-owned lifecycle, V2 remote session, and explicit reopen path while preserving the direct runtime factory as a compatibility escape hatch; creation, turn execution, and daemon-shutdown reattachment are covered by `packages/coding-agent/test/client/server-sdk.test.ts`. Compatibility is covered by direct SDK and server-default client fixtures. |
| Session naming, statusline, and migration tooling | Stock-compatible extension | These consume public model, harness, and TUI seams; no protocol change is required. Compatibility is covered by session-name, statusline, migration, and resource-loader tests. |
| Runtime build identity in diagnostics | Fork core | A diagnostic bundle must identify the fork build and pinned upstream base; stock runtime metadata has no fork-owned release identity boundary. Compatibility is covered by `packages/coding-agent/test/server/daemon-runtime.test.ts`. |

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

The user-visible fork compatibility contract is documented in
[`README.fork.md`](README.fork.md); update it when a supported remote,
plugin, statusline, or extension-boundary promise changes.

## Update policy

Every new fork-core change must add or refine one ledger row with the
extension insufficiency and the compatibility test that protects the boundary.
Reusable adapters should remain isolated from private Pi internals so they can
be proposed upstream independently.
