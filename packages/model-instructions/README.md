# @earendil-works/pi-model-instructions

Resolves trusted, model-specific instruction profiles for server-owned Pi
runtimes. Profiles can provide inline text or a bounded file, select append or
replacement mode, and restrict application to root or subagent agents.

The resolver does not mutate session history. Callers apply the returned
profile to the provider request assembled for the selected model.
