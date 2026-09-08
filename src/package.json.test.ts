import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import packageJson from "../package.json"

it("should have matching engine and dependency versions", () => {
	expect(packageJson.engines.vscode.replace(/^\^/, "")).toBe(
		packageJson.devDependencies["@types/vscode"]
	)
})

describe("production build", () => {
	it("ships one editor WASM asset shared with the browser worker", () => {
		const assets = new URL("../assets/sherlock-editor-app/assets/", import.meta.url)
		const files = readdirSync(assets)
		expect(files.filter((file) => file.endsWith(".wasm"))).toEqual(["lix_js_sdk_bg.wasm"])
		const workers = files.filter((file) => /^entry\.browser.*\.js$/.test(file))
		expect(workers).toHaveLength(1)
		const worker = readFileSync(new URL(workers[0]!, assets), "utf8")
		expect(worker).toContain("/assets/lix_js_sdk_bg.wasm")
		expect(worker).not.toMatch(/lix_js_sdk_bg-[^"/]+\.wasm/)
		expect(existsSync(new URL("../dist/wasm/lix_js_sdk_bg.wasm", import.meta.url))).toBe(true)
	})

	it.each(["lit-html.js", "settings-component.js"])(
		"includes the %s settings dependency",
		(fileName) => {
			expect(existsSync(new URL(`../assets/${fileName}`, import.meta.url))).toBe(true)
		}
	)
})
