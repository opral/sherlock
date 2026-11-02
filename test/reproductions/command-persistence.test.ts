import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import plugin from "@inlang/plugin-i18next"
import { loadProjectFromDirectory, selectBundleNested, type InlangProject } from "@inlang/sdk"
import { applyChanges } from "../../src/utilities/editor/helper/handleBundleUpdate.js"
import { projectResourceSynchronization } from "../../src/utilities/project/projectResourceSynchronization.js"

const host = vi.hoisted(() => ({
	project: undefined as InlangProject | undefined,
	projectPath: "",
	input: vi.fn(),
	error: vi.fn(),
}))
vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	window: { showInputBox: host.input, showErrorMessage: host.error },
}))
vi.mock("../../src/configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: { ON_DID_CREATE_MESSAGE: { fire: vi.fn() }, ON_DID_EDIT_MESSAGE: { fire: vi.fn() } },
	},
}))
vi.mock("../../src/services/telemetry/index.js", () => ({ capture: vi.fn() }))
vi.mock("../../src/utilities/settings/index.js", () => ({ getSetting: vi.fn(async () => false) }))
vi.mock("../../src/utilities/messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("../../src/utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({
		activeProject: () => ({
			project: host.project,
			path: host.projectPath,
			runTask: async (task: () => Promise<unknown>) => ({
				status: "completed",
				value: await task(),
			}),
		}),
	}),
}))

import { createMessageCommand } from "../../src/commands/createMessage.js"
import { editMessageCommand } from "../../src/commands/editMessage.js"

let root = ""
beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "sherlock-persistence-"))
	fs.cpSync(fileURLToPath(new URL("../fixtures/issue-243", import.meta.url)), root, {
		recursive: true,
	})
	host.projectPath = path.join(root, "project.inlang")
	const settingsPath = path.join(host.projectPath, "settings.json")
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
	settings.modules = []
	fs.writeFileSync(settingsPath, JSON.stringify(settings))
	host.project = await loadProjectFromDirectory({
		path: host.projectPath,
		fs,
		providePlugins: [plugin],
	})
})
afterEach(async () => {
	await host.project?.close()
	fs.rmSync(root, { recursive: true, force: true })
	host.input.mockReset()
	host.error.mockReset()
	vi.restoreAllMocks()
})
const read = () => JSON.parse(fs.readFileSync(path.join(root, "locales/en-US/common.json"), "utf8"))

describe("command resource persistence", () => {
	it("Create Message writes its text to the actual resource file", async () => {
		host.input
			.mockResolvedValueOnce("New <strong>{{user}}</strong>")
			.mockResolvedValueOnce("common:newGreeting")
		await createMessageCommand.callback()
		expect(read()).toEqual({
			greetingTitle: "Hello, it is <b>{{time}}</b>!",
			newGreeting: "New <strong>{{user}}</strong>",
		})
	})
	it("quick edit writes the resource file before reporting success", async () => {
		host.input.mockResolvedValueOnce("Updated <strong>{time}</strong>")
		await editMessageCommand.callback({ bundleId: "common:greetingTitle", locale: "en-US" })
		expect(read()).toEqual({ greetingTitle: "Updated <strong>{{time}}</strong>" })
	})
	it("an empty quick edit persists an empty translation", async () => {
		host.input.mockResolvedValueOnce("")
		await editMessageCommand.callback({ bundleId: "common:greetingTitle", locale: "en-US" })
		expect(read()).toEqual({ greetingTitle: "" })
	})

	it("rejects an existing ID without overwriting its graph or resources", async () => {
		const before = await selectBundleNested(host.project!.db).execute()
		host.input.mockResolvedValueOnce("Replacement").mockResolvedValueOnce("common:greetingTitle")
		await createMessageCommand.callback()
		expect(await selectBundleNested(host.project!.db).execute()).toEqual(before)
		expect(read()).toEqual({ greetingTitle: "Hello, it is <b>{{time}}</b>!" })
		expect(host.error).toHaveBeenCalledOnce()
	})

	it("serializes competing creates of the same ID and keeps v7 row identities", async () => {
		host.input.mockImplementation(async ({ title }: { title: string }) =>
			title === "Enter the ID:" ? "common:newGreeting" : "Created"
		)
		await Promise.all([createMessageCommand.callback(), createMessageCommand.callback()])
		const created = (await selectBundleNested(host.project!.db).execute()).find(
			(entry) => entry.id === "common:newGreeting"
		)!
		expect(created.messages).toHaveLength(1)
		expect(created.messages[0]!.variants).toHaveLength(1)
		expect(created.messages[0]!.id[14]).toBe("7")
		expect(created.messages[0]!.variants[0]!.id[14]).toBe("7")
		expect(host.error).toHaveBeenCalledOnce()
		expect(read().newGreeting).toBe("Created")
	})

	it("keeps sibling patterns and declarations changed while quick input is open", async () => {
		await addGermanTranslation()
		let finishInput!: (text: string) => void
		host.input.mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					finishInput = resolve
				})
		)
		const editing = editMessageCommand.callback({
			bundleId: "common:greetingTitle",
			locale: "en-US",
		})
		await vi.waitFor(() => expect(host.input).toHaveBeenCalledOnce())
		const [before] = await selectBundleNested(host.project!.db).execute()
		const sibling = before!.messages.find((message) => message.locale === "de")!.variants[0]!
		const siblingPattern = [
			{
				type: "expression" as const,
				arg: { type: "variable-reference" as const, name: "colleague" },
			},
		]
		await applyChanges(host.project!.db, [
			{ entity: "variant", entityId: sibling.id, newData: { ...sibling, pattern: siblingPattern } },
		])
		finishInput("Changed {time} and {newName}")
		await editing
		const [stored] = await selectBundleNested(host.project!.db).execute()
		expect(
			stored!.messages.find((message) => message.locale === "de")!.variants[0]!.pattern
		).toEqual(siblingPattern)
		expect(stored!.declarations.map((declaration) => declaration.name)).toEqual(
			expect.arrayContaining(["time", "colleague", "newName"])
		)
		expect(read().greetingTitle).toBe("Changed {{time}} and {{newName}}")
	})

	it("serializes simultaneous quick edits without losing either locale or new declarations", async () => {
		await addGermanTranslation()
		const inputs: Array<(text: string) => void> = []
		host.input.mockImplementation(() => new Promise<string>((resolve) => inputs.push(resolve)))
		const first = editMessageCommand.callback({ bundleId: "common:greetingTitle", locale: "en-US" })
		const second = editMessageCommand.callback({ bundleId: "common:greetingTitle", locale: "de" })
		await vi.waitFor(() => expect(inputs).toHaveLength(2))
		inputs[0]!("First {first}")
		inputs[1]!("Second {second}")
		await Promise.all([first, second])
		const [stored] = await selectBundleNested(host.project!.db).execute()
		expect(stored!.declarations.map((declaration) => declaration.name)).toEqual(
			expect.arrayContaining(["first", "second"])
		)
		expect(read().greetingTitle).toBe("First {{first}}")
		expect(
			JSON.parse(fs.readFileSync(path.join(root, "locales/de/common.json"), "utf8")).greetingTitle
		).toBe("Second {{second}}")
	})

	it("awaits resource persistence before completing a quick edit", async () => {
		let releaseSave!: () => void
		const blocked = new Promise<void>((resolve) => {
			releaseSave = resolve
		})
		const save = projectResourceSynchronization.save.bind(projectResourceSynchronization)
		const saving = vi
			.spyOn(projectResourceSynchronization, "save")
			.mockImplementation(async (...args) => {
				await blocked
				await save(...args)
			})
		host.input.mockResolvedValueOnce("After {name}")
		let finished = false
		const editing = editMessageCommand
			.callback({ bundleId: "common:greetingTitle", locale: "en-US" })
			.then(() => {
				finished = true
			})
		await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce())
		expect(finished).toBe(false)
		releaseSave()
		await editing
		expect(read().greetingTitle).toBe("After {{name}}")
	})
})

async function addGermanTranslation() {
	const settings = await host.project!.settings.get()
	await host.project!.settings.set({ ...settings, locales: [...settings.locales, "de"] })
	await host.project!.importFiles({
		pluginKey: plugin.key,
		files: [
			{
				locale: "de",
				toBeImportedFilesMetadata: { namespace: "common" },
				content: new TextEncoder().encode(JSON.stringify({ greetingTitle: "Hallo" })),
			},
		],
	})
}
