import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A minimal hook harness lets us exercise the webview boundary without loading
// the browser-only editor components or adding a DOM dependency to unit tests.
const hooks = vi.hoisted(() => ({
	installed: false,
	cleanup: undefined as undefined | (() => void),
	setState: vi.fn(),
}))
vi.mock("react", () => ({
	useState: () => [undefined, hooks.setState],
	useEffect: (effect: () => () => void) => {
		if (hooks.installed) return
		hooks.installed = true
		hooks.cleanup = effect()
	},
}))
vi.mock("./components/Editor.js", () => ({ default: () => null }))

import App from "./App.js"
import { vscode } from "./utils/vscode.js"

describe("editor frontend lifecycle", () => {
	let target: EventTarget
	beforeEach(() => {
		target = new EventTarget()
		vi.stubGlobal("window", target)
		hooks.installed = false
		hooks.cleanup = undefined
		hooks.setState.mockClear()
	})
	afterEach(() => {
		hooks.cleanup?.()
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("installs one listener across renders and removes it when unmounted", () => {
		const add = vi.spyOn(target, "addEventListener")
		const remove = vi.spyOn(target, "removeEventListener")
		const post = vi.spyOn(vscode, "postMessage")
		for (let index = 0; index < 6; index += 1) App()
		expect(add).toHaveBeenCalledOnce()
		expect(post).toHaveBeenCalledExactlyOnceWith({ command: "ready" })
		target.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "change",
					data: { bundle: { id: "hello", messages: [] }, settings: { locales: [] } },
				},
			})
		)
		expect(hooks.setState).toHaveBeenCalledTimes(1)
		hooks.cleanup?.()
		expect(remove).toHaveBeenCalledWith("message", add.mock.calls[0]![1])
		hooks.setState.mockClear()
		target.dispatchEvent(
			new MessageEvent("message", {
				data: { command: "change", data: { bundle: { messages: [] }, settings: { locales: [] } } },
			})
		)
		expect(hooks.setState).not.toHaveBeenCalled()
	})

	it("preserves the host's reset request after a failed save", () => {
		App()
		target.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "change",
					reset: true,
					data: { bundle: { id: "hello", messages: [] }, settings: { locales: [] } },
				},
			})
		)
		expect(hooks.setState).toHaveBeenCalledTimes(2)
		expect(hooks.setState.mock.calls[1]![0](3)).toBe(4)
	})

	it("ignores unrelated and malformed messages without changing editor state", () => {
		App()
		for (const data of [
			null,
			"change",
			{},
			{ command: "other" },
			{ command: "change" },
			{ command: "change", data: null },
			{ command: "change", data: {} },
			{ command: "change", data: { bundle: "bad", settings: { locales: [] } } },
			{ command: "change", data: { bundle: { messages: [] }, settings: {} } },
		]) {
			target.dispatchEvent(new MessageEvent("message", { data }))
		}
		expect(hooks.setState).not.toHaveBeenCalled()
	})

	it("returns an unsubscribe callback from the VS Code message wrapper", () => {
		const receive = vi.fn()
		const unsubscribe = vscode.onMessage(receive)
		target.dispatchEvent(new MessageEvent("message", { data: "first" }))
		unsubscribe()
		target.dispatchEvent(new MessageEvent("message", { data: "second" }))
		expect(receive).toHaveBeenCalledExactlyOnceWith("first")
	})
})
