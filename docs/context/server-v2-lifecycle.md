# Server V2 lifecycle

`PiServerV2` validates `maxFrameLength` as a positive safe integer no larger than uint32 and `handshakeTimeoutMs` as a positive safe integer no larger than Node's timer delay. Startup is shared across concurrent callers through one promise. Connection teardown is guarded by per-connection close/disconnect promises and a server-wide runtime disposal guard, so transport callbacks cannot dispose the same runtime twice. A handshake remains non-ready until bounded replay completes; replay is accepted only for a session present in the authorized `listSessions()` snapshot.
