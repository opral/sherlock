// Run: node node_modules/vitest/vitest.mjs run test/reproductions/issue-243.test.ts
// Regression coverage for the original report, using the actual resource plugin and SDK.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import plugin from "@inlang/plugin-i18next"
import {
	loadProjectFromDirectory,
	selectBundleNested,
	type BundleNested,
	type InlangProject,
} from "@inlang/sdk"

const host = vi.hoisted(() => ({ errors: [] as string[], created: 0 }))

// Keep the real msg() implementation, replacing only the VS Code UI boundary.
vi.mock("vscode", () => ({
	StatusBarAlignment: { Left: 1 },
	window: {
		createStatusBarItem: () => {
			host.created++
			return {
				text: "",
				show() {
					host.errors.push(this.text)
				},
				hide() {},
			}
		},
	},
}))
vi.mock("../../src/configuration.js", () => ({
	CONFIGURATION: { STRINGS: { MISSING_TRANSLATION_MESSAGE: "[missing]" } },
}))

import { getStringFromPattern } from "../../src/utilities/messages/query.js"
import { createMessageHtml } from "../../src/utilities/messages/messages.js"

let root: string
let project: InlangProject
let bundle: BundleNested

async function loadFixture() {
	// Use the lockfile-pinned official plugin artifact without relying on a CDN.
	return loadProjectFromDirectory({
		path: path.join(root, "project.inlang"),
		fs,
		providePlugins: [plugin],
	})
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "sherlock-issue-243-"))
	fs.cpSync(fileURLToPath(new URL("../fixtures/issue-243", import.meta.url)), root, {
		recursive: true,
	})
	const settingsPath = path.join(root, "project.inlang/settings.json")
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
	settings.modules = []
	fs.writeFileSync(settingsPath, JSON.stringify(settings))
	project = await loadFixture()
	expect(await project.errors.get()).toEqual([])
	;[bundle] = await selectBundleNested(project.db).execute()
})

afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
	host.errors.length = 0
	host.created = 0
})

afterAll(async () => {
	await project?.close()
	if (root) fs.rmSync(root, { recursive: true, force: true })
})

function captureStatusBarCalls() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
}

describe("issue #243 reproduction with the real i18next plugin and SDK", () => {
	it("preserves imported markup without creating notifications or timers", () => {
		captureStatusBarCalls()
		const message = bundle.messages[0]!
		const pattern = message.variants[0]!.pattern
		expect(bundle.id).toBe("common:greetingTitle")
		expect(pattern.map((element) => element.type)).toEqual([
			"text",
			"markup-start",
			"expression",
			"markup-end",
			"text",
		])
		expect(getStringFromPattern({ pattern, locale: message.locale, messageId: message.id })).toBe(
			"Hello, it is <b>{time}</b>!"
		)
		expect(host.errors).toEqual([])
		expect(host.created).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("escapes HTML in previews and creates no notifications on repeated renders", async () => {
		captureStatusBarCalls()
		const render = () =>
			createMessageHtml({
				bundle,
				project,
				projectPath: path.join(root, "project.inlang"),
				workspaceFolder: { uri: { fsPath: root } } as any,
				isHighlighted: false,
			})
		for (let i = 0; i < 3; i++) {
			const html = await render()
			expect(html).toContain("Hello, it is &lt;b&gt;{time}&lt;/b&gt;!")
			expect(html).not.toContain("<b>")
		}
		expect(host.created).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("stops emitting errors when the HTML tags are removed from the resource file", async () => {
		const resourcePath = path.join(root, "locales/en-US/common.json")
		const original = fs.readFileSync(resourcePath, "utf8")
		fs.writeFileSync(resourcePath, JSON.stringify({ greetingTitle: "Hello, it is {{time}}!" }))
		const withoutMarkup = await loadFixture()
		try {
			const [plainBundle] = await selectBundleNested(withoutMarkup.db).execute()
			const message = plainBundle!.messages[0]!
			captureStatusBarCalls()
			expect(
				getStringFromPattern({
					pattern: message.variants[0]!.pattern,
					locale: message.locale,
					messageId: message.id,
				})
			).toBe("Hello, it is {time}!")
			expect(host.created).toBe(0)
		} finally {
			vi.clearAllTimers()
			vi.useRealTimers()
			await withoutMarkup.close()
			fs.writeFileSync(resourcePath, original)
		}
	})

	it("saves the native markup AST and reloads identical JSON", async () => {
		const message = bundle.messages[0]!
		const variant = message.variants[0]!
		const original = fs.readFileSync(path.join(root, "locales/en-US/common.json"), "utf8")
		const typed = structuredClone(variant.pattern)
		captureStatusBarCalls()
		expect(
			getStringFromPattern({ pattern: typed, locale: message.locale, messageId: message.id })
		).toBe("Hello, it is <b>{time}</b>!")
		expect(host.created).toBe(0)
		vi.useRealTimers()

		await project.db
			.updateTable("inlang_variant")
			.where("id", "=", variant.id)
			.set({ pattern: typed })
			.execute()
		const exported = await project.exportFiles({ pluginKey: plugin.key })
		expect(exported).toHaveLength(1)
		const saved = new TextDecoder().decode(exported[0]!.content)
		expect(saved).toBe(original)
		fs.writeFileSync(path.join(root, "locales/en-US/common.json"), saved)

		const reloaded = await loadFixture()
		try {
			const [reloadedBundle] = await selectBundleNested(reloaded.db).execute()
			const reloadedMessage = reloadedBundle!.messages[0]!
			captureStatusBarCalls()
			expect(
				getStringFromPattern({
					pattern: reloadedMessage.variants[0]!.pattern,
					locale: reloadedMessage.locale,
					messageId: reloadedMessage.id,
				})
			).toBe("Hello, it is <b>{time}</b>!")
			expect(reloadedMessage.variants[0]!.pattern).toEqual(typed)
			expect(host.created).toBe(0)
		} finally {
			vi.clearAllTimers()
			vi.useRealTimers()
			await reloaded.close()
		}
	})

	it("renders 2,300 tagged keys × 13 locales with zero status-bar items or timers", async () => {
		// Amplify the actual imported pattern; this does not benchmark VS Code IPC or its UI.
		const locales = [
			"en-US",
			"en-GB",
			"en-AU",
			"de",
			"es",
			"fr",
			"hu",
			"it",
			"nl",
			"pl",
			"pt",
			"tr",
			"zh-CN",
		]
		const source = bundle.messages[0]!
		const stressProject = { settings: { get: async () => ({ locales }) } } as InlangProject
		const stressBundles = Array.from({ length: 2300 }, (_, index) => ({
			...bundle,
			id: `namespace${index % 35}:greeting${index}`,
			messages: locales.map((locale) => ({ ...source, locale })),
		}))
		captureStatusBarCalls()
		const started = performance.now()
		await Promise.all(
			stressBundles.map((entry) =>
				createMessageHtml({
					bundle: entry,
					project: stressProject,
					projectPath: path.join(root, "project.inlang"),
					workspaceFolder: { uri: { fsPath: root } } as any,
					isHighlighted: false,
				})
			)
		)
		expect(host.created).toBe(0)
		expect(vi.getTimerCount()).toBe(host.created)
		console.info(
			`Issue #243: ${host.created.toLocaleString("en-US")} status-bar items/timers in ${(performance.now() - started).toFixed(0)}ms (mock UI boundary).`
		)
	})
})
