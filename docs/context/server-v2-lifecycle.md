# Server V2 lifecycle

`PiServerV2` validates `maxFrameLength` as a positive safe integer no larger than uint32 and `handshakeTimeoutMs` as a positive safe integer no larger than Node's timer delay. Startup is shared across concurrent callers through one promise. Connection teardown is guarded by per-connection close/disconnect promises and a server-wide runtime disposal guard, so transport callbacks cannot dispose the same runtime twice. A handshake remains non-ready until bounded replay completes; replay is accepted only for a session present in the authorized `listSessions()` snapshot.

Session reads use the same handshake-visible session set before calling the service runtime opener; connection errors and rejected closes still run disconnect cleanup. Server close awaits an in-flight startup promise before closing listeners, preventing a listener from being started after close returns.

Listener shutdown is best-effort and ordered as a lifecycle barrier: all listener close promises are awaited with `Promise.allSettled`, each rejection is reported, and active connections/runtimes are then closed. A listener startup failure marks the server non-restartable and applies the same cleanup to every configured listener and any connections accepted before the failure.
