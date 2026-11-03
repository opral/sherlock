import { browser, expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import vscode from "vscode"
import {} from "wdio-vscode-service"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const enMessagesPath = path.join(workspacePath, "messages/en.json")
const deMessagesPath = path.join(workspacePath, "messages/de.json")
const originalEnMessages = {
	hello_world: "Hello world",
	welcome_user: "Welcome, {name}!",
	missing_in_german: "This message is intentionally missing in German",
}
const originalDeMessages = {
	hello_world: "Hallo Welt",
	welcome_user: "Willkommen, {name}!",
}

async function writeJson(filePath: string, messages: Record<string, string>) {
	await fs.writeFile(filePath, `${JSON.stringify(messages, undefined, "\t")}\n`)
}

async function resetMessages() {
	await writeJson(enMessagesPath, originalEnMessages)
	await writeJson(deMessagesPath, originalDeMessages)
}

async function readEnMessages() {
	return JSON.parse(await fs.readFile(enMessagesPath, "utf8")) as Record<string, string>
}

async function readDeMessages() {
	return JSON.parse(await fs.readFile(deMessagesPath, "utf8")) as Record<string, string>
}

describe("Issue #198: edit view fields accept normal text edits", () => {
	beforeEach(async () => {
		await resetMessages()
	})

	afterEach(async () => {
		await resetMessages()
	})

	it("persists typing, backspace, and paste in existing and empty translation fields", async () => {
		const workbench = await browser.getWorkbench()

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
			await extension?.activate()
			await vscodeApi.commands.executeCommand("sherlock.reloadProject")
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "hello_world",
			})
		})

		const webview = await workbench.getWebviewByTitle("hello_world")
		await webview.open()

		const editor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await editor.waitForDisplayed({ timeout: 30_000 })
		await expect(editor).toHaveText("Hello world")

		await editor.click()
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"])
		await browser.keys("Editable textx")
		await browser.keys("Backspace")

		await browser.executeWorkbench(async (vscodeApi: typeof vscode, text: string) => {
			await vscodeApi.env.clipboard.writeText(text)
		}, " pasted")
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "v"])
		await browser.waitUntil(async () => (await editor.getText()) === "Editable text pasted", {
			timeout: 5_000,
			timeoutMsg: "Expected the existing translation editor to contain pasted text",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readEnMessages()
				return messages.hello_world === "Editable text pasted"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected edit-view text changes to be saved to messages/en.json",
			}
		)

		await webview.close()

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "missing_in_german",
			})
		})

		const missingWebview = await workbench.getWebviewByTitle("missing_in_german")
		await missingWebview.open()

		// Missing locales render an empty draft field immediately.
		const germanEditor = await $(
			'section[data-locale="de"] inlang-pattern-editor .inlang-pattern-editor-contenteditable'
		)
		await germanEditor.waitForDisplayed({ timeout: 30_000 })
		await expect(germanEditor).toHaveText("")
		await germanEditor.click()
		await browser.keys("Deutschx")
		await browser.keys("Backspace")
		await browser.executeWorkbench(async (vscodeApi: typeof vscode, text: string) => {
			await vscodeApi.env.clipboard.writeText(text)
		}, " pasted")
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "v"])
		await browser.waitUntil(async () => (await germanEditor.getText()) === "Deutsch pasted", {
			timeout: 5_000,
			timeoutMsg: "Expected the empty German editor to accept typed and pasted text",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readDeMessages()
				return messages.missing_in_german === "Deutsch pasted"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected empty non-base locale edits to be saved to messages/de.json",
			}
		)

		await missingWebview.close()

		expect((await readEnMessages()).hello_world).toBe("Editable text pasted")
		expect((await readDeMessages()).missing_in_german).toBe("Deutsch pasted")
	})
})
