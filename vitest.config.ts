import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The agent sandbox is runtime state (staged review copies live here).
		// Without this, any *.test.ts staged under the workspace double-runs
		// the suite (observed: 258 instead of 143).
		exclude: ["node_modules", "dist", ".pi-swarm-workspace/**"],
	},
});
