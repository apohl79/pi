# apohl79/pi fork compatibility

This document records fork-specific behavior layered on Pi's public packages
and the v2 server/client boundary. It is separate from the upstream Pi README
so upstream-compatible extensions can keep using the normal package APIs.

## Runtime boundary

The configured coding-agent daemon owns sessions, accepted turns, child-agent
lifecycles, tools, goals, plugin activation, usage, diagnostics, and execution
host state. TUI, CLI, RPC, and SDK clients attach to that state and may detach
without cancelling server-owned work.

Pi's `AgentHarness`, provider catalog, tools, sessions, and extension APIs
remain the execution baseline. Existing TypeScript extensions continue to
load. Extensions are classified as `client`, `server`, or `both`; client-only
UI state cannot become authoritative for a durable turn.

## Remote references and media

- Bare and path-scoped `@` references resolve on the selected execution host.
- Canonical server references use `server:<path>`; `@server:` is accepted as
  input/presentation syntax. Explicit client uploads use `@local:<path>` and
  are transferred through bounded content-addressed blobs.
- Web results are bounded, attributable, and routed through the typed web
  service; private-network targets and credential-bearing URLs are rejected by
  default.
- Image view and generation use blob references, MIME/size validation, and
  session-scoped attribution.

## Codex-compatible plugin resources

The plugin adapter supports local, Git, and npm marketplace metadata plus
portable manifest resources: skills, commands, hooks, apps, interface
metadata, persistent context, sampling context, activation, provenance, and
`plugin://` mentions. The resolved plugin set is frozen at turn acceptance;
changes apply to the next turn. Resource paths are confined beneath the
declared plugin root, including symlink checks.

MCP declarations are deliberately not activated. A plugin containing
`mcpServers` or `.mcp.json` receives an explicit unsupported-resource
diagnostic while independent supported resources may still load.

## Sampling context

Plugin sampling contributions are request-only overlays. They are rebuilt per
provider request, bounded before serialization, excluded from durable
transcripts and compaction history, and included in per-request usage and
diagnostic outcomes. Pi-native extensions use the same typed contributor
boundary.

## Statusline and cost

The remote TUI runs statusline commands on the client host asynchronously with
bounded output and timeout handling. Its JSON input identifies the server,
session, operation, model, usage, active agents, goal, and diagnostics state;
stale results cannot overwrite newer renders.

Usage is ledger-derived. Missing prices remain explicitly `unknown`, and
side-band work such as automatic naming is tagged with its purpose so it is
not confused with visible-turn usage.

## Compatibility promises

- Protocol v1 behavior and existing Pi-native extension loading remain intact.
- v2 clients validate snapshots, event cursors, and response DTOs before
  applying them locally.
- Fork-core changes are recorded with their extension insufficiency and tests
  in [`FORK_DELTA.md`](FORK_DELTA.md).
- MCP, filesystem rollback, realtime voice/audio, and Codex's internal binary
  Rust extension ABI are outside this compatibility boundary.
