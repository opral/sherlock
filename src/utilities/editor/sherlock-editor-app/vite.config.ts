import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],
	worker: {
		rollupOptions: {
			output: {
				// Share assets emitted by both the editor and its worker builds.
				assetFileNames: `assets/[name].[ext]`,
			},
		},
	},
	build: {
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
