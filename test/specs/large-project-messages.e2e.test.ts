// Stress run: SHERLOCK_LARGE_KEYS=10000 SHERLOCK_LARGE_NAMESPACES=35 SHERLOCK_LARGE_REFERENCES=611
// ./node_modules/.bin/wdio run test/wdio.conf.ts --spec test/specs/large-project-messages.e2e.test.ts
// SHERLOCK_LARGE_RELOAD=0 isolates load/search/save when diagnosing reload failures.
import { browser, expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import vscode from "vscode"
import {} from "wdio-vscode-service"
import { e2ePluginFixtureUrl } from "../helpers/pluginFixtureServer.js"
import { snapshotWorkspacePaths } from "../helpers/workspaceFixture.js"
import { openEditorBundle } from "../helpers/editorBundle.js"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const settingsPath = path.join(workspacePath, "project.inlang/settings.json")
const sourcePath = path.join(workspacePath, "src/large-project.js")
const translationsPath = path.join(workspacePath, "large-translations")
const keys = Number(process.env.SHERLOCK_LARGE_KEYS ?? 611)
const reloadAfterSave = process.env.SHERLOCK_LARGE_RELOAD !== "0"
const namespaceCount = Math.min(Number(process.env.SHERLOCK_LARGE_NAMESPACES ?? 1), keys)
const referenceCount = Math.min(keys, Number(process.env.SHERLOCK_LARGE_REFERENCES ?? 150))
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
const namespaces = Array.from({ length: namespaceCount }, (_, index) =>
	index ? `namespace_${index}` : "misc"
)
const namespaceOf = (index: number) => namespaces[index % namespaceCount]!
const keyOf = (index: number) => `key_${String(index).padStart(5, "0")}`
const idOf = (index: number) => `${namespaceOf(index)}:${keyOf(index)}`
const resourcePath = (locale: string, namespace: string) =>
	path.join(translationsPath, locale, `${namespace}.json`)

async function messagesSnapshot() {
	await browser.switchToFrame(null)
	try {
		const workbench = await browser.getWorkbench()
		const view = await workbench.getWebviewByTitle("Inlang Message View")
		await view.open()
		return await browser.execute(() => ({
			rows: document.querySelectorAll("main .tree-item").length,
			highlighted: document.querySelectorAll(".highlighted-section .tree-item").length,
			text: document.body.innerText.slice(0, 250),
		}))
	} finally {
		await browser.switchToFrame(null)
	}
}

async function waitForMessages(expectedHighlights?: number) {
	let observed: unknown
	await browser.waitUntil(
		async () => {
			try {
				const snapshot = await messagesSnapshot()
				observed = snapshot
				return (
					snapshot.rows === keys &&
					(expectedHighlights === undefined || snapshot.highlighted === expectedHighlights)
				)
			} catch {
				return false
			}
		},
		{
			timeout: 60_000,
			interval: 500,
			timeoutMsg: `Expected ${keys} messages and ${expectedHighlights ?? "any"} highlights`,
		}
	)
	console.log(
		JSON.stringify({
			keys,
			locales: locales.length,
			namespaceCount,
			referenceCount,
			snapshot: observed,
		})
	)
}

describe("Large i18next projects (#246)", () => {
	let fixture: Awaited<ReturnType<typeof snapshotWorkspacePaths>>
	before(async () => {
		// Settle the initial workspace before replacing its resource configuration.
		await browser.executeWorkbench(async (api: typeof vscode) => {
			await api.extensions.getExtension("inlang.vs-code-extension")?.activate()
		})
		fixture = await snapshotWorkspacePaths([settingsPath, sourcePath, translationsPath])
		for (const locale of locales) {
			await fs.mkdir(path.join(translationsPath, locale), { recursive: true })
			const resources = new Map(
				namespaces.map((namespace) => [namespace, {} as Record<string, string>])
			)
			for (let index = 0; index < keys; index++) {
				resources.get(namespaceOf(index))![keyOf(index)] =
					`${locale} translation ${index} for {{name}}`
			}
			for (const [namespace, values] of resources) {
				await fs.writeFile(resourcePath(locale, namespace), JSON.stringify(values))
			}
		}
		await fs.mkdir(path.dirname(sourcePath), { recursive: true })
		await fs.writeFile(
			sourcePath,
			[
				'import { t } from "i18next"',
				...Array.from(
					{ length: referenceCount },
					(_, index) => `t(${JSON.stringify(idOf(index))})`
				),
				`t(${JSON.stringify(idOf(0))})`,
				't("misc:unknown_reference")',
			].join("\n")
		)
		await fs.writeFile(
			settingsPath,
			JSON.stringify({
				baseLocale: locales[0],
				locales,
				modules: [e2ePluginFixtureUrl("i18next")],
				"plugin.inlang.i18next": {
					pathPattern: Object.fromEntries(
						namespaces.map((namespace) => [
							namespace,
							`./large-translations/{locale}/${namespace}.json`,
						])
					),
					contextValues: [],
					variableReferencePattern: ["{{", "}}"],
				},
			})
		)
		await browser.executeWorkbench(async (api: typeof vscode) => {
			await api.extensions.getExtension("inlang.vs-code-extension")?.activate()
			await api.commands.executeCommand("sherlock.reloadProject")
			await api.commands.executeCommand("workbench.action.closeAllEditors")
			await api.commands.executeCommand("workbench.view.extension.sherlock")
			await api.commands.executeCommand("messageView.focus")
		})
	})
	after(async () => {
		await fixture?.restore()
	})

	it("loads all messages and remains usable with many references, duplicates, and an unknown key", async () => {
		await waitForMessages()
		await browser.executeWorkbench(async (api: typeof vscode, file: string) => {
			await api.window.showTextDocument(await api.workspace.openTextDocument(api.Uri.file(file)))
		}, sourcePath)
		await waitForMessages(referenceCount)
	})

	it("searches translations near the end of the project", async () => {
		const view = await (await browser.getWorkbench()).getWebviewByTitle("Inlang Message View")
		await view.open()
		try {
			await $("#searchInput").setValue(`zh-CN translation ${keys - 1} for`)
			await browser.waitUntil(
				async () => {
					return await browser.execute(
						(expected: string) => {
							const visible = [...document.querySelectorAll<HTMLElement>("main .tree-item")].filter(
								(item) => item.style.display !== "none"
							)
							return visible.length === 1 && visible[0]!.innerText.includes(expected)
						},
						idOf(keys - 1)
					)
				},
				{
					timeout: 10_000,
					interval: 250,
					timeoutMsg: "Search should include every locale and the final key",
				}
			)
			const lastHeader = await $(`main .collapsible[data-message-id="${idOf(keys - 1)}"]`)
			await lastHeader.click()
			await browser.waitUntil(
				async () => {
					return await browser.execute(
						(id: string) => {
							const header = [...document.querySelectorAll<HTMLElement>("main .collapsible")].find(
								(item) => item.dataset.messageId === id
							)
							return header?.nextElementSibling?.textContent?.includes("zh-CN translation") ?? false
						},
						idOf(keys - 1)
					)
				},
				{
					timeout: 10_000,
					interval: 250,
					timeoutMsg: "Expanding a message must load its translations",
				}
			)
			await $("#searchInput").click()
			const modifier = process.platform === "darwin" ? "\uE03D" : "\uE009"
			await browser.action("key").down(modifier).down("a").up("a").up(modifier).perform()
			await browser.keys("Backspace")
			await browser.waitUntil(
				async () =>
					await browser.execute(
						(expected: number) =>
							[...document.querySelectorAll<HTMLElement>("main .tree-item")].filter(
								(item) => item.style.display !== "none"
							).length === expected,
						keys
					),
				{ timeout: 10_000, interval: 250 }
			)
		} finally {
			await view.close()
		}
	})

	it(`saves a translation without losing other keys or locales${reloadAfterSave ? ", then reloads" : ""}`, async () => {
		const editor = await openEditorBundle(idOf(0))
		const value = "Updated large project translation {name}"
		try {
			await editor.editFirstPattern(value)
		} finally {
			await editor.close()
		}
		await browser.waitUntil(
			async () => {
				const values = JSON.parse(await fs.readFile(resourcePath("en-US", namespaceOf(0)), "utf8"))
				return values[keyOf(0)] === "Updated large project translation {{name}}"
			},
			{ timeout: 60_000, interval: 500, timeoutMsg: "Translation edit was not persisted" }
		)
		let total = 0
		for (const namespace of namespaces) {
			total += Object.keys(
				JSON.parse(await fs.readFile(resourcePath("en-US", namespace), "utf8"))
			).length
		}
		expect(total).toBe(keys)
		const otherLocale = JSON.parse(await fs.readFile(resourcePath("en-GB", namespaceOf(0)), "utf8"))
		expect(otherLocale[keyOf(0)]).toBe("en-GB translation 0 for {{name}}")
		if (reloadAfterSave) {
			const reload = await browser.executeWorkbench(async (api: typeof vscode) => {
				try {
					return { result: await api.commands.executeCommand<string>("sherlock.reloadProject") }
				} catch (error) {
					return { error: String(error), stack: (error as Error).stack }
				}
			})
			expect(reload).toEqual({ result: "committed" })
			await waitForMessages()
			const view = await (await browser.getWorkbench()).getWebviewByTitle("Inlang Message View")
			await view.open()
			try {
				const header = await $(`main .collapsible[data-message-id="${idOf(0)}"]`)
				await header.click()
				await browser.waitUntil(
					async () =>
						await browser.execute(
							(id: string) =>
								[...document.querySelectorAll<HTMLElement>("main .collapsible")]
									.find((item) => item.dataset.messageId === id)
									?.nextElementSibling?.textContent?.includes(
										"Updated large project translation"
									) ?? false,
							idOf(0)
						),
					{ timeout: 10_000, interval: 250 }
				)
			} finally {
				await view.close()
			}
		}
	})
})
