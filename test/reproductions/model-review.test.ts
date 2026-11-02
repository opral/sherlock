import { afterEach, describe, expect, it, vi } from "vitest"
import i18next from "@inlang/plugin-i18next"
import {
	loadProjectInMemory,
	newProject,
	selectBundleNested,
	type InlangProject,
} from "@inlang/sdk"
import {
	normalizeVariantEdit,
	normalizeVariantChange,
} from "../../src/utilities/editor/helper/normalizeVariantEdit.js"
import {
	patternToEditorText,
	patternToText,
	textToPattern,
} from "../../src/utilities/messages/pattern.js"

import { writeBundle } from "../../src/utilities/editor/helper/writeBundle.js"
import {
	handleUpdateBundle,
	applyResourceChanges,
} from "../../src/utilities/editor/helper/handleBundleUpdate.js"
import { deleteVariant } from "../../src/utilities/editor/helper/deleteVariant.js"

const commandHost = vi.hoisted(() => ({
	project: undefined as InlangProject | undefined,
	input: vi.fn(),
	error: vi.fn(),
	save: vi.fn(async () => undefined),
}))
vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	window: { showInputBox: commandHost.input, showErrorMessage: commandHost.error },
}))
vi.mock("../../src/configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_CREATE_MESSAGE: { fire: vi.fn() },
			ON_DID_EDITOR_VIEW_CHANGE: { fire: vi.fn() },
		},
	},
}))
vi.mock("../../src/utilities/messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("../../src/utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({
		activeProject: () => ({
			project: commandHost.project,
			path: "/workspace/project.inlang",
			runTask: async (task: () => Promise<unknown>) => ({
				status: "completed",
				value: await task(),
			}),
		}),
	}),
}))
vi.mock("../../src/utilities/project/projectResourceSynchronization.js", () => ({
	saveProjectResources: commandHost.save,
}))
vi.mock("../../src/services/telemetry/index.js", () => ({ capture: vi.fn() }))
vi.mock("../../src/utilities/settings/index.js", () => ({ getSetting: vi.fn(async () => false) }))
import { editMessageCommand } from "../../src/commands/editMessage.js"
import { createMessageCommand } from "../../src/commands/createMessage.js"

const projects: InlangProject[] = []
afterEach(async () => {
	commandHost.project = undefined
	commandHost.input.mockReset()
	commandHost.error.mockReset()
	commandHost.save.mockReset()
	commandHost.save.mockResolvedValue(undefined)
	await Promise.all(projects.splice(0).map((project) => project.close()))
})

async function setup(values: Record<string, string>) {
	const project = await loadProjectInMemory({
		blob: await newProject({
			settings: {
				baseLocale: "en",
				locales: ["en"],
				modules: [],
				[i18next.key]: { pathPattern: "./messages/{locale}.json" },
			},
		}),
		providePlugins: [i18next],
	})
	projects.push(project)
	await project.importFiles({
		pluginKey: i18next.key,
		files: [{ locale: "en", content: new TextEncoder().encode(JSON.stringify(values)) }],
	})
	const [bundle] = await selectBundleNested(project.db).execute()
	return { project, bundle: bundle!, message: bundle!.messages[0]! }
}

describe("complete selector context during resource parsing", () => {
	it.each([
		["context fallback", { greeting: "Hello", greeting_male: "Sir" }],
		["plural fallback", { greeting: "Hello", greeting_one: "One", greeting_other: "Many" }],
		[
			"zero and cardinal plural",
			{ greeting_zero: "None", greeting_one: "One", greeting_other: "Many" },
		],
		[
			"combined context and plural fallbacks",
			{
				greeting_male_one: "One sir",
				greeting_male_other: "Many sirs",
				greeting_one: "One",
				greeting_other: "Many",
			},
		],
	])("edits every variant in %s messages", async (_, values) => {
		const { project, bundle, message } = await setup(values)
		for (const variant of message.variants) {
			const pattern = await normalizeVariantEdit({
				project,
				bundle,
				variant,
				pattern: textToPattern("Changed <b>{name}</b>"),
			})
			expect(patternToText(pattern), JSON.stringify(variant.matches)).toBe("Changed <b>{name}</b>")
			expect(pattern.map((element) => element.type)).toEqual([
				"text",
				"markup-start",
				"expression",
				"markup-end",
			])
		}
	})
})

describe("unchanged token identity while editing surrounding text", () => {
	it("keeps literal brace text separate from a real interpolation", async () => {
		const { project, bundle, message } = await setup({
			greeting: "Literal {name}, interpolation {{name}}",
		})
		const variant = message.variants[0]!
		const pattern = await normalizeVariantEdit({
			project,
			bundle,
			variant,
			pattern: textToPattern(`Changed ${patternToEditorText(variant.pattern)}`, variant.pattern),
		})
		expect(pattern).toEqual([
			{ type: "text", value: "Changed Literal {name}, interpolation " },
			{ type: "expression", arg: { type: "variable-reference", name: "name" } },
		])
	})

	it("keeps repeated literal words in text separate from literal expressions", () => {
		const previous = [
			{ type: "text" as const, value: "literal " },
			{ type: "expression" as const, arg: { type: "literal" as const, value: "literal" } },
		]
		expect(textToPattern(`Changed ${patternToEditorText(previous)}`, previous)).toEqual([
			{ type: "text", value: "Changed literal " },
			previous[1],
		])
	})

	it("preserves literal versus variable arguments with equal displayed format annotations", () => {
		const annotation = { type: "function-reference" as const, name: "number", options: [] }
		const previous = [
			{
				type: "expression" as const,
				arg: { type: "literal" as const, value: "amount" },
				annotation,
			},
			{ type: "text" as const, value: " versus " },
			{
				type: "expression" as const,
				arg: { type: "variable-reference" as const, name: "amount" },
				annotation,
			},
		]
		expect(textToPattern(`Changed ${patternToEditorText(previous)}`, previous)).toEqual([
			{ type: "text", value: "Changed " },
			...previous,
		])
	})
})

describe("canonical graph persistence", () => {
	it("returns one canonical message per locale when a resource has several plural keys", async () => {
		const { project, bundle, message } = await setup({
			greeting_one: "One",
			greeting_other: "Many",
		})
		const canonical = await normalizeVariantChange({
			project,
			bundle,
			variant: message.variants[0]!,
			pattern: textToPattern("Changed"),
		})
		expect(canonical.messages).toHaveLength(1)
		expect(
			new Set(canonical.messages.flatMap((entry) => entry.variants.map((variant) => variant.id)))
				.size
		).toBe(canonical.messages.flatMap((entry) => entry.variants).length)
	})

	it("persists editing either zero alias and keeps the shared source entry consistent on reload", async () => {
		const { project } = await setup({
			greeting_zero: "None",
			greeting_one: "One",
			greeting_other: "Many",
		})
		const [original] = await selectBundleNested(project.db).execute()
		const aliases = original!.messages[0]!.variants.filter((variant) =>
			variant.matches.some(
				(match) =>
					match.type === "literal-match" && (match.key === "count" || match.value === "zero")
			)
		)
		expect(aliases).toHaveLength(2)
		for (const [index, alias] of aliases.entries()) {
			const [bundle] = await selectBundleNested(project.db).execute()
			const variant = bundle!.messages[0]!.variants.find((entry) => entry.id === alias.id)!
			const canonical = await normalizeVariantChange({
				project,
				bundle: bundle!,
				variant,
				pattern: textToPattern(`Changed ${index} {name}`),
			})
			await writeBundle(project.db, canonical)
			const [file] = await project.exportFiles({ pluginKey: i18next.key })
			expect(JSON.parse(new TextDecoder().decode(file!.content))).toEqual({
				greeting_zero: `Changed ${index} {{name}}`,
				greeting_one: "One",
				greeting_other: "Many",
			})
			await project.importFiles({
				pluginKey: i18next.key,
				files: [{ ...file!, toBeImportedFilesMetadata: file!.metadata }],
			})
			const [reloaded] = await selectBundleNested(project.db).execute()
			expect(
				reloaded!.messages[0]!.variants.filter((entry) =>
					aliases.some((old) => old.id === entry.id)
				).map((entry) => patternToText(entry.pattern))
			).toEqual([`Changed ${index} {name}`, `Changed ${index} {name}`])
		}
	})
})

describe("quick edit keeps fresh sibling state", () => {
	it("does not overwrite another locale changed while the input dialog is open", async () => {
		const { project } = await setup({ greeting: "Before" })
		await project.importFiles({
			pluginKey: i18next.key,
			files: [
				{ locale: "de", content: new TextEncoder().encode(JSON.stringify({ greeting: "Alt" })) },
			],
		})
		commandHost.project = project
		let finishInput!: (text: string) => void
		commandHost.input.mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					finishInput = resolve
				})
		)
		const pendingEdit = editMessageCommand.callback({ bundleId: "greeting", locale: "en" })
		await vi.waitFor(() => expect(commandHost.input).toHaveBeenCalledOnce())
		const [bundle] = await selectBundleNested(project.db).execute()
		const sibling = bundle!.messages.find((message) => message.locale === "de")!.variants[0]!
		await project.db
			.updateTable("inlang_variant")
			.where("id", "=", sibling.id)
			.set({ pattern: [{ type: "text", value: "Neu" }] })
			.execute()
		finishInput("After")
		await pendingEdit
		const [stored] = await selectBundleNested(project.db).execute()
		expect(
			patternToText(
				stored!.messages.find((message) => message.locale === "de")!.variants[0]!.pattern
			)
		).toBe("Neu")
		expect(
			patternToText(
				stored!.messages.find((message) => message.locale === "en")!.variants[0]!.pattern
			)
		).toBe("After")
	})
})

describe("creation preserves existing translation identity", () => {
	it("rejects an existing ID without adding duplicate locale messages or replacing declarations", async () => {
		const { project } = await setup({ greeting: "Before {{old}}" })
		commandHost.project = project
		const before = await selectBundleNested(project.db).execute()
		commandHost.input.mockResolvedValueOnce("After {{next}}").mockResolvedValueOnce("greeting")
		await createMessageCommand.callback()
		expect(await selectBundleNested(project.db).execute()).toEqual(before)
		expect(commandHost.error).toHaveBeenCalledOnce()
	})
})

describe("structural updates share the pattern mutation lock", () => {
	it("does not overwrite declaration updates queued while the resource parser is pending", async () => {
		const { project, bundle, message } = await setup({ greeting: "Before" })
		let releaseParser!: () => void
		let parserStarted!: () => void
		const parserBlocked = new Promise<void>((resolve) => {
			releaseParser = resolve
		})
		const started = new Promise<void>((resolve) => {
			parserStarted = resolve
		})
		project.plugins.get = async () => [
			{
				...i18next,
				importFiles: async (args) => {
					parserStarted()
					await parserBlocked
					return i18next.importFiles!(args)
				},
			},
		]
		const variant = message.variants[0]!
		const edit = handleUpdateBundle({
			project,
			message: {
				command: "change",
				change: {
					entity: "variant",
					entityId: variant.id,
					newData: { ...variant, pattern: textToPattern("After") },
				},
			},
		})
		await started
		let structureFinished = false
		const structural = handleUpdateBundle({
			project,
			message: {
				command: "change",
				change: {
					entity: "bundle",
					entityId: bundle.id,
					newData: { id: bundle.id, declarations: [{ type: "input-variable", name: "manual" }] },
				},
			},
		}).then((result) => {
			structureFinished = true
			return result
		})
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		const finishedBeforeParser = structureFinished
		releaseParser()
		expect(await Promise.all([edit, structural])).toEqual([true, true])
		expect(finishedBeforeParser).toBe(false)
		const [stored] = await selectBundleNested(project.db).execute()
		expect(stored!.declarations).toEqual([{ type: "input-variable", name: "manual" }])
		expect(patternToText(stored!.messages[0]!.variants[0]!.pattern)).toBe("After")
	})
})

describe("command changes persist before reporting completion", () => {
	it("persists a newly created canonical translation", async () => {
		const { project } = await setup({ greeting: "Before" })
		commandHost.project = project
		commandHost.input.mockResolvedValueOnce("New {{name}}").mockResolvedValueOnce("newGreeting")
		await createMessageCommand.callback()
		expect(commandHost.save).toHaveBeenCalledExactlyOnceWith(project, "/workspace/project.inlang")
		const created = (await selectBundleNested(project.db).execute()).find(
			(bundle) => bundle.id === "newGreeting"
		)!
		expect(created.declarations).toEqual([{ type: "input-variable", name: "name" }])
	})

	it("awaits resource persistence before completing a quick edit", async () => {
		const { project } = await setup({ greeting: "Before" })
		commandHost.project = project
		commandHost.input.mockResolvedValueOnce("After {name}")
		let releaseSave!: () => void
		commandHost.save.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					releaseSave = resolve
				})
		)
		let finished = false
		const pending = editMessageCommand.callback({ bundleId: "greeting", locale: "en" }).then(() => {
			finished = true
		})
		await vi.waitFor(() =>
			expect(commandHost.save).toHaveBeenCalledExactlyOnceWith(project, "/workspace/project.inlang")
		)
		const finishedBeforeSave = finished
		releaseSave()
		await pending
		expect(finishedBeforeSave).toBe(false)
		const [stored] = await selectBundleNested(project.db).execute()
		expect(stored!.declarations).toEqual([{ type: "input-variable", name: "name" }])
	})
})

describe("deletion preserves the canonical resource model", () => {
	it.each(["count", "countPlural"])(
		"deletes both source aliases when selecting the %s zero variant",
		async (matchKey) => {
			const { project, message } = await setup({
				greeting_zero: "None {{onlyZero}}",
				greeting_one: "One {{onlyOne}}",
				greeting_other: "Many",
			})
			const selected = message.variants.find((variant) =>
				variant.matches.some(
					(match) =>
						match.type === "literal-match" &&
						match.key === matchKey &&
						(match.value === "0" || match.value === "zero")
				)
			)!
			expect(await deleteVariant({ project, variantId: selected.id })).toBe(true)
			const [stored] = await selectBundleNested(project.db).execute()
			expect(stored!.declarations.some((declaration) => declaration.name === "onlyZero")).toBe(
				false
			)
			expect(stored!.declarations.some((declaration) => declaration.name === "onlyOne")).toBe(true)
			expect(stored!.messages[0]!.variants).toHaveLength(2)
			const [file] = await project.exportFiles({ pluginKey: i18next.key })
			expect(JSON.parse(new TextDecoder().decode(file!.content))).toEqual({
				greeting_one: "One {{onlyOne}}",
				greeting_other: "Many",
			})
			await project.importFiles({
				pluginKey: i18next.key,
				files: [{ ...file!, toBeImportedFilesMetadata: file!.metadata }],
			})
			const [reloaded] = await selectBundleNested(project.db).execute()
			expect(reloaded!.messages[0]!.variants).toHaveLength(2)
			expect(reloaded!.declarations.some((declaration) => declaration.name === "onlyZero")).toBe(
				false
			)
		}
	)

	it("removes an emptied locale and its declarations while preserving another locale", async () => {
		const { project, message } = await setup({ greeting: "Hello {{enName}}" })
		await project.importFiles({
			pluginKey: i18next.key,
			files: [
				{
					locale: "de",
					content: new TextEncoder().encode(JSON.stringify({ greeting: "Hallo {{deName}}" })),
				},
			],
		})
		expect(await deleteVariant({ project, variantId: message.variants[0]!.id })).toBe(true)
		const [stored] = await selectBundleNested(project.db).execute()
		expect(stored!.messages.map((entry) => entry.locale)).toEqual(["de"])
		expect(stored!.declarations).toEqual([{ type: "input-variable", name: "deName" }])
		const files = await project.exportFiles({ pluginKey: i18next.key })
		expect(files.map((file) => file.locale)).toEqual(["de"])
	})

	it("keeps an empty bundle available for adding locales after its last translation is deleted", async () => {
		const { project, message } = await setup({ greeting: "Hello {{name}}" })
		expect(await deleteVariant({ project, variantId: message.variants[0]!.id })).toBe(true)
		expect(await selectBundleNested(project.db).execute()).toEqual([
			{ id: "greeting", declarations: [], messages: [] },
		])
		expect(await project.exportFiles({ pluginKey: i18next.key })).toEqual([])
	})
})

describe("SDK 4 canonical graph transactions", () => {
	it("writes only inlang columns inside an existing transaction", async () => {
		const { project, bundle, message } = await setup({ greeting: "Before" })
		const canonical = await normalizeVariantChange({
			project,
			bundle,
			variant: message.variants[0]!,
			pattern: textToPattern("After"),
		})
		Object.assign(canonical.messages[0]!, {
			lixcol_file_id: "must-not-write",
			lixcol_created_at: "must-not-write",
		})
		Object.assign(canonical.messages[0]!.variants[0]!, {
			lixcol_file_id: "must-not-write",
			lixcol_updated_at: "must-not-write",
		})
		await project.db.transaction().execute(async (trx) => {
			await writeBundle(trx, canonical)
		})
		const [stored] = await selectBundleNested(project.db).execute()
		expect(patternToText(stored!.messages[0]!.variants[0]!.pattern)).toBe("After")
	})

	it("rolls back a graph replacement with the caller's transaction", async () => {
		const { project, bundle, message } = await setup({ greeting: "Before" })
		const canonical = await normalizeVariantChange({
			project,
			bundle,
			variant: message.variants[0]!,
			pattern: textToPattern("After {name}"),
		})
		await expect(
			project.db.transaction().execute(async (trx) => {
				await writeBundle(trx, canonical)
				throw new Error("Abort canonical update")
			})
		).rejects.toThrow("Abort canonical update")
		expect(await selectBundleNested(project.db).execute()).toEqual([bundle])
	})
})

describe("batched shared resource edits", () => {
	it("rejects conflicting edits to two model aliases without silently choosing one value", async () => {
		const { project, bundle, message } = await setup({
			greeting_zero: "None",
			greeting_one: "One",
			greeting_other: "Many",
		})
		const aliases = message.variants.filter((variant) =>
			variant.matches.some(
				(match) =>
					match.type === "literal-match" && (match.key === "count" || match.value === "zero")
			)
		)
		expect(aliases).toHaveLength(2)
		await expect(
			applyResourceChanges({
				project,
				bundleId: bundle.id,
				changes: aliases.map((variant, index) => ({
					entity: "variant" as const,
					entityId: variant.id,
					newData: { ...variant, pattern: textToPattern(`Conflicting ${index}`) },
				})),
			})
		).rejects.toThrow(/alias|same resource|conflict/i)
		expect(await selectBundleNested(project.db).execute()).toEqual([bundle])
	})
})
