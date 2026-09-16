import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import packageJson from "../package.json"

it("should have matching engine and dependency versions", () => {
	expect(packageJson.engines.vscode.replace(/^\^/, "")).toBe(
		packageJson.devDependencies["@types/vscode"]
	)
})

describe("production build", () => {
	it("ships Lix workers and their engine, migration, and component WASM assets", () => {
		const assets = new URL("../assets/sherlock-editor-app/assets/", import.meta.url)
		const files = readdirSync(assets)
		const wasmFiles = files.filter((file) => file.endsWith(".wasm"))
		const engine = readFileSync(new URL("../dist/wasm/lix_js_sdk_bg.wasm", import.meta.url))
		// Dedicated and shared workers must reuse one copy of the engine.
		expect(
			wasmFiles.filter((file) => readFileSync(new URL(file, assets)).equals(engine))
		).toHaveLength(1)
		expect(files.filter((file) => /^entry\.browser.*\.js$/.test(file))).toHaveLength(1)
		expect(files.filter((file) => /^entry\.shared\.browser.*\.js$/.test(file))).toHaveLength(1)
		const scripts = files
			.filter((file) => file.endsWith(".js"))
			.map((file) => readFileSync(new URL(file, assets), "utf8"))
			.join("\n")
		const referencedWasm = [...scripts.matchAll(/\/assets\/([^"'\s/]+\.wasm)/g)].map(
			(match) => match[1]
		)
		expect(referencedWasm.length).toBeGreaterThan(0)
		for (const file of referencedWasm) {
			expect(wasmFiles).toContain(file)
		}
	})

	it.each(["lit-html.js", "settings-component.js"])(
		"includes the %s settings dependency",
		(fileName) => {
			expect(existsSync(new URL(`../assets/${fileName}`, import.meta.url))).toBe(true)
		}
	)
})
