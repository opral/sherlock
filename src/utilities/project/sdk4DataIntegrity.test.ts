/**
 * Runs Sherlock's queries and saves against a real SDK 4 project with the published
 * message-format (4.5) and m-function-matcher (2.3) plugins: no mocked database.
 *
 * Covers the table and column names of SDK 4 (`inlang_*`, `bundle_id`, `message_id`), that rows
 * read with `selectAll()` (which include `lixcol_*` columns) can be written back, and that saving
 * keeps every file byte-identical except for the entries that were edited.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { InlangProject } from "@inlang/sdk"

vi.mock("vscode", () => ({
	window: {
		createStatusBarItem: () => ({ show: vi.fn(), dispose: vi.fn() }),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showInputBox: vi.fn(),
	},
	commands: { registerCommand: vi.fn() },
	StatusBarAlignment: { Left: 1, Right: 2 },
	workspace: {},
}))

vi.mock("../../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_EDITOR_VIEW_CHANGE: { fire: vi.fn() },
			ON_DID_CREATE_MESSAGE: { fire: vi.fn() },
		},
	},
}))

vi.mock("../../services/telemetry/index.js", () => ({ capture: vi.fn() }))
vi.mock("../settings/index.js", () => ({ getSetting: vi.fn(async () => false) }))

const activeLease = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock("./projectRuntime.js", () => ({
	getProjectRuntime: () => ({ activeProject: () => activeLease.current }),
}))

const { createProjectResourceSynchronization } = await import("./projectResourceSynchronization.js")
const { selectBundleById } = await import("./selectBundleById.js")
const { handleUpdateBundle } = await import("../editor/helper/handleBundleUpdate.js")
const { createMessage } = await import("../editor/helper/createMessage.js")
const { deleteVariant } = await import("../editor/helper/deleteVariant.js")
const { deleteBundleNested } = await import("../editor/helper/deleteBundleNested.js")
const { editMessageCommand } = await import("../../commands/editMessage.js")
const { createMessageCommand } = await import("../../commands/createMessage.js")
const vscode = await import("vscode")

const require = createRequire(import.meta.url)
const MESSAGE_FORMAT_URL =
	"https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js"
const MATCHER_URL = "https://cdn.jsdelivr.net/npm/@inlang/plugin-m-function-matcher@2/dist/index.js"
const pluginSources: Record<string, string> = {
	[MESSAGE_FORMAT_URL]: require.resolve("@inlang/plugin-message-format"),
	[MATCHER_URL]: require.resolve("@inlang/plugin-m-function-matcher"),
}

// Hand-written files: two-space indentation, keys out of order, an escape, a flat dotted key,
// a nested key and a plural. A save must not reformat any of it.
const EN = `{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "zebra": "Zebra",
  "greeting": "Hello {name}",
  "caf\\u00e9": "Caf\\u00e9",
  "nav.home": "Home",
  "settings": {
    "title": "Settings"
  },
  "items": [
    {
      "declarations": ["input count", "local countPlural = count: plural"],
      "selectors": ["countPlural"],
      "match": {
        "countPlural=one": "{count} item",
        "countPlural=other": "{count} items"
      }
    }
  ],
  "farewell": "Bye"
}
`
const DE = `{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "zebra": "Zebra",
  "greeting": "Hallo {name}",
  "nav.home": "Startseite",
  "settings": {
    "title": "Einstellungen"
  },
  "farewell": "Tschüss"
}
`
const SETTINGS = `{
  "$schema": "https://inlang.com/schema/project-settings",
  "baseLocale": "en",
  "locales": ["en", "de"],
  "modules": [
    "${MESSAGE_FORMAT_URL}",
    "${MATCHER_URL}"
  ],
  "plugin.inlang.messageFormat": {
    "pathPattern": "./messages/{locale}.json"
  }
}
`

let workspace: string
let projectPath: string
let project: InlangProject
const sync = createProjectResourceSynchronization()

const read = (file: string) => fs.readFile(path.join(workspace, file), "utf8")
const save = () => sync.save(project, projectPath)

beforeEach(async () => {
	const realFetch = globalThis.fetch
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const file = pluginSources[url]
		if (file) return new Response(await fs.readFile(file, "utf8"))
		return realFetch(input, init)
	})
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-sdk4-"))
	projectPath = path.join(workspace, "project.inlang")
	await fs.mkdir(projectPath)
	await fs.mkdir(path.join(workspace, "messages"))
	await fs.writeFile(path.join(projectPath, "settings.json"), SETTINGS)
	await fs.writeFile(path.join(workspace, "messages/en.json"), EN)
	await fs.writeFile(path.join(workspace, "messages/de.json"), DE)
	project = await sync.load(projectPath)
	activeLease.current = {
		project,
		path: projectPath,
		isCurrent: () => true,
		runTask: async (task: () => Promise<unknown>) => ({ status: "completed", value: await task() }),
	}
	// The first save writes the SDK's own metadata (README, .gitignore, .meta.json) into the project.
	await save()
})

afterEach(async () => {
	await project?.close()
	vi.unstubAllGlobals()
	await fs.rm(workspace, { recursive: true, force: true })
})

describe("SDK 4 data integrity", () => {
	it("loads the project with both plugins and reads nested rows with snake_case ids", async () => {
		const plugins = await project.plugins.get()
		expect(plugins.map((plugin) => plugin.key).sort()).toEqual(
			["plugin.inlang.mFunctionMatcher", "plugin.inlang.messageFormat"].sort()
		)
		const bundle = await selectBundleById(project, "greeting")
		expect(bundle?.messages.map((message) => message.locale).sort()).toEqual(["de", "en"])
		for (const message of bundle!.messages) {
			expect(message.bundle_id).toBe("greeting")
			for (const variant of message.variants) expect(variant.message_id).toBe(message.id)
		}
	})

	it("keeps every file byte-identical when nothing changed", async () => {
		await save()
		await save()
		expect(await read("messages/en.json")).toBe(EN)
		expect(await read("messages/de.json")).toBe(DE)
		expect(await read("project.inlang/settings.json")).toBe(SETTINGS)
	})

	it("writes back a row read with selectAll() (lixcol_* columns) and changes only that entry", async () => {
		const row = await project.db
			.selectFrom("inlang_variant")
			.innerJoin("inlang_message", "inlang_message.id", "inlang_variant.message_id")
			.where("inlang_message.bundle_id", "=", "greeting")
			.where("inlang_message.locale", "=", "de")
			.selectAll("inlang_variant")
			.executeTakeFirstOrThrow()
		expect(Object.keys(row).some((key) => key.startsWith("lixcol_"))).toBe(true)

		await handleUpdateBundle({
			db: project.db,
			message: {
				command: "change",
				change: {
					entity: "variant",
					entityId: row.id,
					newData: {
						...row,
						pattern: [
							{ type: "text", value: "Servus " },
							{ type: "expression", arg: { type: "variable-reference", name: "name" } },
						],
					} as any,
				},
			},
		})
		await save()

		expect(await read("messages/de.json")).toBe(
			DE.replace(`"greeting": "Hallo {name}"`, `"greeting": "Servus {name}"`)
		)
		expect(await read("messages/en.json")).toBe(EN)
		expect(await read("project.inlang/settings.json")).toBe(SETTINGS)
	})

	it("edits a message through the edit command (updateTable on inlang_message / inlang_variant)", async () => {
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Good bye")
		await editMessageCommand.callback({ bundleId: "farewell", locale: "en" })
		await save()

		expect(await read("messages/en.json")).toBe(
			EN.replace(`"farewell": "Bye"`, `"farewell": "Good bye"`)
		)
		expect(await read("messages/de.json")).toBe(DE)
	})

	it("creates a message through the create command with uuid v7 ids and inserts only that key", async () => {
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce("Brand new")
			.mockResolvedValueOnce("brand_new")
		await createMessageCommand.callback()

		const bundle = await selectBundleById(project, "brand_new")
		const message = bundle!.messages[0]!
		expect(message.bundle_id).toBe("brand_new")
		expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
		expect(message.variants[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
		expect(await read("messages/en.json")).toBe(
			EN.replace(`"farewell": "Bye"\n}`, `"farewell": "Bye",\n  "brand_new": "Brand new"\n}`)
		)
		expect(await read("messages/de.json")).toBe(DE)
	})

	it("edits a flat dotted key in place", async () => {
		const bundle = await selectBundleById(project, "nav.home")
		const variant = bundle!.messages.find((message) => message.locale === "de")!.variants[0]!
		await handleUpdateBundle({
			db: project.db,
			message: {
				command: "change",
				change: {
					entity: "variant",
					entityId: variant.id,
					newData: { ...variant, pattern: [{ type: "text", value: "Start" }] },
				},
			},
		})
		await save()

		expect(await read("messages/de.json")).toBe(
			DE.replace(`"nav.home": "Startseite"`, `"nav.home": "Start"`)
		)
		expect(await read("messages/en.json")).toBe(EN)
	})

	it("creates a missing translation with a uuid v7 variant and inserts only that key", async () => {
		const id = "01890000-0000-7000-8000-000000000001"
		await createMessage({
			db: project.db,
			message: {
				id,
				bundle_id: "café",
				locale: "de",
				selectors: [],
				// what the webview may send along: never written
				...({ lixcol_file_id: "x", variants: [] } as object),
			},
		})
		const bundle = await selectBundleById(project, "café")
		const message = bundle!.messages.find((m) => m.locale === "de")!
		expect(message.id).toBe(id)
		expect(message.variants).toHaveLength(1)
		expect(message.variants[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)

		await handleUpdateBundle({
			db: project.db,
			message: {
				command: "change",
				change: {
					entity: "variant",
					entityId: message.variants[0]!.id,
					newData: { ...message.variants[0]!, pattern: [{ type: "text", value: "Café" }] },
				},
			},
		})
		await save()

		const de = JSON.parse(await read("messages/de.json"))
		expect(de["café"]).toBe("Café")
		// every other line of the file is unchanged
		const before = DE.split("\n")
		const after = (await read("messages/de.json")).split("\n")
		expect(after.filter((line) => !line.includes("Café"))).toEqual(before)
		expect(await read("messages/en.json")).toBe(EN)
	})

	it("deletes a plural form and changes only that message", async () => {
		const bundle = await selectBundleById(project, "items")
		const en = bundle!.messages.find((message) => message.locale === "en")!
		const one = en.variants.find((variant) =>
			variant.matches.some((match) => match.type === "literal-match" && match.value === "one")
		)!
		await deleteVariant({ db: project.db, variantId: one.id })
		await save()

		const after = await read("messages/en.json")
		expect(after).not.toContain(`"countPlural=one"`)
		expect(after).toContain(`"countPlural=other": "{count} items"`)
		expect(after.replace(/ {2}"items": \[[\s\S]*?\n {2}\],\n/, "")).toBe(
			EN.replace(/ {2}"items": \[[\s\S]*?\n {2}\],\n/, "")
		)
		expect(await read("messages/de.json")).toBe(DE)
	})

	it("deletes a bundle in every locale and keeps the rest of the files", async () => {
		await deleteBundleNested({ db: project.db, bundleId: "zebra" })
		expect(await selectBundleById(project, "zebra")).toBeUndefined()
		expect(
			await project.db
				.selectFrom("inlang_message")
				.where("bundle_id", "=", "zebra")
				.select("id")
				.execute()
		).toEqual([])
		await save()

		expect(await read("messages/en.json")).toBe(EN.replace(`  "zebra": "Zebra",\n`, ""))
		expect(await read("messages/de.json")).toBe(DE.replace(`  "zebra": "Zebra",\n`, ""))
	})
})
