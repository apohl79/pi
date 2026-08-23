import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-codex-plugin-compat$/,
					replacement: fileURLToPath(new URL("../codex-plugin-compat/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-client\/unix$/,
					replacement: fileURLToPath(new URL("../client/src/unix.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-client\/diagnostics$/,
					replacement: fileURLToPath(new URL("../client/src/diagnostics.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-session-backend-sqlite-node$/,
					replacement: fileURLToPath(new URL("../session-backends/sqlite-node/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-server$/,
					replacement: fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-model-instructions$/,
					replacement: fileURLToPath(new URL("../model-instructions/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-session-naming$/,
					replacement: fileURLToPath(new URL("../session-naming/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-web-tools$/,
					replacement: fileURLToPath(new URL("../web-tools/src/index.ts", import.meta.url)),
				},
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
