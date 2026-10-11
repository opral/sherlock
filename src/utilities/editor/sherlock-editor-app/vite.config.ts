import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	resolve: {
		// the webview never opens a project: keep the Lix engine out of the bundle
		alias: [
			{
				find: /^@lix-js\/sdk$/,
				replacement: fileURLToPath(new URL("./src/lib/lixStub.ts", import.meta.url)),
			},
		],
	},
	build: {
		target: "es2022",
		outDir: "build",
		rollupOptions: {
			output: {
				entryFileNames: `assets/[name].js`,
				chunkFileNames: `assets/[name].js`,
				assetFileNames: `assets/[name].[ext]`,
			},
		},
	},
	server: {
		hmr: {
			host: "localhost",
			protocol: "ws",
		},
	},
	optimizeDeps: {
		exclude: ["@inlang/sdk", "@sqlite.org/sqlite-wasm", "@eliaspourquoi/sqlite-node-wasm"],
	},
})
