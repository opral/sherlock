import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import plugin from "@inlang/plugin-i18next"
import { loadProjectFromDirectory, type InlangProject } from "@inlang/sdk"

const host = vi.hoisted(() => ({
	project: undefined as InlangProject | undefined,
	projectPath: "",
	input: vi.fn(),
}))
vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	window: { showInputBox: host.input, showErrorMessage: vi.fn() },
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
})
const read = () => JSON.parse(fs.readFileSync(path.join(root, "locales/en-US/common.json"), "utf8"))

describe("command resource persistence", () => {
	it("Create Message writes the canonical translation to the actual resource file", async () => {
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
})
