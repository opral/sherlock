// Regression coverage for model inconsistencies discovered during the follow-up audit.
// Run: node node_modules/vitest/vitest.mjs run test/reproductions/similar-bugs.audit.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import plugin from "@inlang/plugin-i18next"
import {
	loadProjectInMemory,
	newProject,
	selectBundleNested,
	type InlangProject,
} from "@inlang/sdk"

const host = vi.hoisted(() => ({
	project: undefined as InlangProject | undefined,
	input: vi.fn(),
	pick: vi.fn(),
}))
vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn(), registerTextEditorCommand: vi.fn() },
	window: { showInputBox: host.input, showQuickPick: host.pick, showErrorMessage: vi.fn() },
}))
vi.mock("../../src/configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_CREATE_MESSAGE: { fire: vi.fn() },
			ON_DID_EXTRACT_MESSAGE: { fire: vi.fn() },
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
		},
	},
}))
vi.mock("../../src/utilities/messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("../../src/services/telemetry/index.js", () => ({ capture: vi.fn() }))
vi.mock("../../src/utilities/settings/index.js", () => ({ getSetting: vi.fn(async () => false) }))
vi.mock("../../src/utilities/project/projectResourceSynchronization.js", () => ({
	saveProjectResources: vi.fn(async () => undefined),
}))
vi.mock("../../src/utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({
		activeProject: () => ({
			project: host.project,
			path: "/workspace/project.inlang",
			runTask: async (task: () => Promise<unknown>) => ({
				status: "completed",
				value: await task(),
			}),
		}),
	}),
}))

import { createMessageCommand } from "../../src/commands/createMessage.js"
import { extractMessageCommand } from "../../src/commands/extractMessage.js"
import { handleUpdateBundle } from "../../src/utilities/editor/helper/handleBundleUpdate.js"
import { prepareProject } from "../../src/utilities/state.js"
import { textToPattern } from "../../src/utilities/messages/pattern.js"

const projects: InlangProject[] = []
afterEach(async () => {
	await Promise.all(projects.splice(0).map((project) => project.close()))
	host.project = undefined
	host.input.mockReset()
	host.pick.mockReset()
})

async function setup() {
	const settings = {
		baseLocale: "en-US",
		locales: ["en-US"],
		modules: [],
		"plugin.inlang.i18next": {
			pathPattern: { common: "./locales/{locale}/common.json" },
			variableReferencePattern: ["{{", "}}"],
		},
	}
	const project = await loadProjectInMemory({
		blob: await newProject({ settings }),
		providePlugins: [{ ...plugin }],
	})
	projects.push(project)
	host.project = project
	prepareProject(project)
	return project
}

async function reimport(project: InlangProject) {
	const files = await project.exportFiles({ pluginKey: plugin.key })
	await project.importFiles({
		pluginKey: plugin.key,
		files: files.map((file) => ({ ...file, toBeImportedFilesMetadata: file.metadata })),
	})
	const [bundle] = await selectBundleNested(project.db).execute()
	return bundle!
}

const source = "Hello, it is <b>{{time}}</b>!"

describe("canonical create, extract and edit models", () => {
	it("Create Message parses markup and variables before storing them", async () => {
		const project = await setup()
		host.input.mockResolvedValueOnce(source).mockResolvedValueOnce("common:greetingTitle")
		await createMessageCommand.callback()
		const [created] = await selectBundleNested(project.db).execute()
		expect(created!.messages[0]!.variants[0]!.pattern.map((element) => element.type)).toEqual([
			"text",
			"markup-start",
			"expression",
			"markup-end",
			"text",
		])
		expect(created!.declarations).toEqual([{ type: "input-variable", name: "time" }])
		const reloaded = await reimport(project)
		expect(reloaded.messages[0]!.variants[0]!.pattern.map((element) => element.type)).toEqual([
			"text",
			"markup-start",
			"expression",
			"markup-end",
			"text",
		])
		expect(reloaded.declarations).toEqual([{ type: "input-variable", name: "time" }])
	})

	it("Extract Message stores the same canonical model as resource loading", async () => {
		const project = await setup()
		host.input.mockResolvedValueOnce("common:greetingTitle")
		host.pick.mockImplementation(async (choices: string[]) => choices[0])
		const replace = vi.fn()
		await extractMessageCommand.callback({
			selection: { isEmpty: false },
			document: { getText: () => JSON.stringify(source) },
			edit: async (callback: (editor: { replace: typeof replace }) => void) => {
				callback({ replace })
				return true
			},
		} as any)
		expect(replace).toHaveBeenCalledOnce()
		const [created] = await selectBundleNested(project.db).execute()
		expect(created!.messages[0]!.variants[0]!.pattern.map((element) => element.type)).toEqual([
			"text",
			"markup-start",
			"expression",
			"markup-end",
			"text",
		])
		expect((await reimport(project)).messages[0]!.variants[0]!.pattern).toEqual(
			created!.messages[0]!.variants[0]!.pattern
		)
	})

	it("editing a variable updates its declaration immediately", async () => {
		const project = await setup()
		await project.importFiles({
			pluginKey: plugin.key,
			files: [
				{
					locale: "en-US",
					toBeImportedFilesMetadata: { namespace: "common" },
					content: new TextEncoder().encode(JSON.stringify({ greetingTitle: "Hello {{name}}" })),
				},
			],
		})
		const [bundle] = await selectBundleNested(project.db).execute()
		const variant = bundle!.messages[0]!.variants[0]!
		await handleUpdateBundle({
			project,
			message: {
				command: "change",
				change: {
					entityId: variant.id,
					entity: "variant",
					newData: { ...variant, pattern: textToPattern("Hello {time}") },
				},
			},
		})
		const [edited] = await selectBundleNested(project.db).execute()
		expect(edited!.messages[0]!.variants[0]!.pattern).toContainEqual({
			type: "expression",
			arg: { type: "variable-reference", name: "time" },
		})
		expect(edited!.declarations).toEqual([{ type: "input-variable", name: "time" }])
		expect((await reimport(project)).declarations).toEqual([
			{ type: "input-variable", name: "time" },
		])
	})
})
