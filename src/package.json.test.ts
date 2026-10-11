import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import packageJson from "../package.json"

it("should have matching engine and dependency versions", () => {
	expect(packageJson.engines.vscode.replace(/^\^/, "")).toBe(
		packageJson.devDependencies["@types/vscode"]
	)
})

describe("production build", () => {
	it("ships the Lix worker and engine for the extension, and none in the editor webview", () => {
		// the extension host opens projects with the Lix engine
		expect(existsSync(new URL("../dist/wasm/lix_js_sdk_bg.wasm", import.meta.url))).toBe(true)
		expect(existsSync(new URL("../dist/entry.node.js", import.meta.url))).toBe(true)
		// the editor webview only uses the SDK's pure helpers: no engine, no workers
		const assets = new URL("../assets/sherlock-editor-app/assets/", import.meta.url)
		const files = readdirSync(assets)
		expect(files.filter((file) => file.endsWith(".wasm"))).toEqual([])
		expect(files.filter((file) => /^entry\./.test(file))).toEqual([])
		const scripts = files
			.filter((file) => file.endsWith(".js"))
			.map((file) => readFileSync(new URL(file, assets), "utf8"))
			.join("\n")
		expect(scripts).toContain("inlang-pattern-editor")
		expect(scripts).toContain("inlang-message-forms")
	})

	it.each(["lit-html.js", "settings-component.js"])(
		"includes the %s settings dependency",
		(fileName) => {
			expect(existsSync(new URL(`../assets/${fileName}`, import.meta.url))).toBe(true)
		}
	)
})
