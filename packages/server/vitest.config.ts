import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: {
			"@earendil-works/pi-diagnostics": fileURLToPath(new URL("../diagnostics/src/index.ts", import.meta.url)),
			"@earendil-works/pi-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			"@earendil-works/pi-web-tools": fileURLToPath(new URL("../web-tools/src/index.ts", import.meta.url)),
		},
	},
});
