# Server process registry resource bounds

`NodeV2ProcessRegistry` owns child-process lifecycle and retains completed process snapshots. Active capacity is reserved before `spawn`, released when a child reaches terminal state, and released if spawning throws or emits a startup error. `maxActiveProcesses` and `maxWriteBytes` are positive-integer constructor limits; writes exceeding `maxWriteBytes` are rejected before data is sent to stdin.
