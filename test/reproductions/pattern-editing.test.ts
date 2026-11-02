import { afterEach, describe, expect, it, vi } from "vitest"
import i18next from "@inlang/plugin-i18next"
import json from "@inlang/plugin-json"
import {
	loadProjectInMemory,
	newProject,
	selectBundleNested,
	type InlangPlugin,
	type InlangProject,
	type ProjectSettings,
} from "@inlang/sdk"
import { normalizeVariantEdit } from "../../src/utilities/editor/helper/normalizeVariantEdit.js"
import {
	editableVariant,
	patternToEditorText,
	patternToText,
	textToPattern,
} from "../../src/utilities/messages/pattern.js"
import { handleUpdateBundle } from "../../src/utilities/editor/helper/handleBundleUpdate.js"
import { collectPatternErrors } from "../../src/utilities/errors/patternErrors.js"

const host = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock("../../src/utilities/messages/msg.js", () => ({ msg: host.notify }))

const projects: InlangProject[] = []
afterEach(async () => {
	await Promise.all(projects.splice(0).map((project) => project.close()))
	host.notify.mockClear()
})

async function setup(
	plugin: InlangPlugin,
	values: Record<string, string>,
	pluginSettings: Record<string, unknown>
) {
	const settings: ProjectSettings = {
		baseLocale: "en-US",
		locales: ["en-US"],
		modules: [],
		[plugin.key]: pluginSettings,
	}
	const project = await loadProjectInMemory({
		blob: await newProject({ settings }),
		providePlugins: [plugin],
	})
	projects.push(project)
	await project.importFiles({
		pluginKey: plugin.key,
		files: [
			{
				locale: "en-US",
				content: new TextEncoder().encode(JSON.stringify(values)),
				toBeImportedFilesMetadata: plugin === i18next ? { namespace: "common" } : undefined,
			},
		],
	})
	const [bundle] = await selectBundleNested(project.db).execute()
	if (!bundle) throw new Error("Fixture was not imported")
	return { project, bundle, message: bundle.messages[0]! }
}
const i18nextSettings = {
	pathPattern: { common: "./locales/{locale}/common.json" },
	variableReferencePattern: ["{{", "}}"],
}

describe("resource plugin is the parser for both loading and editing", () => {
	it.each([
		[
			"nested and numeric tags",
			"Hi <b>{{time}}</b>",
			"Hello <strong><0>{time}</0></strong><br/>",
			"Hello <strong><0>{{time}}</0></strong><br/>",
			i18nextSettings,
		],
		[
			"format annotations",
			"Total <b>{{amount, number}}</b>",
			"New total <b>{amount, number}</b>",
			"New total <b>{{amount, number}}</b>",
			i18nextSettings,
		],
		[
			"changed format annotations",
			"Total {{amount, number}}",
			"New total {amount, currency}",
			"New total {{amount, currency}}",
			i18nextSettings,
		],
		[
			"custom interpolation",
			"Hi <b>[[time]]</b>",
			"Hello <strong>{time}</strong><br/>",
			"Hello <strong>[[time]]</strong><br/>",
			{ ...i18nextSettings, variableReferencePattern: ["[[", "]]"] },
		],
		[
			"incomplete tags",
			"Hi <b>{{time}}</b>",
			"Hello <strong{time}",
			"Hello <strong{{time}}",
			i18nextSettings,
		],
	])(
		"preserves %s across edit, export and import",
		async (_, initial, text, expected, settings) => {
			const { project, bundle, message } = await setup(
				i18next,
				{ greetingTitle: initial },
				settings
			)
			const variant = message.variants[0]!
			const pattern = await normalizeVariantEdit({
				project,
				bundle,
				variant,
				pattern: textToPattern(text),
			})
			await project.db
				.updateTable("inlang_variant")
				.where("id", "=", variant.id)
				.set({ pattern })
				.execute()
			const [file] = await project.exportFiles({ pluginKey: i18next.key })
			expect(JSON.parse(new TextDecoder().decode(file!.content))).toEqual({
				greetingTitle: expected,
			})
			await project.importFiles({
				pluginKey: i18next.key,
				files: [{ ...file!, toBeImportedFilesMetadata: file!.metadata }],
			})
			const [reloaded] = await selectBundleNested(project.db).execute()
			expect(reloaded!.messages[0]!.variants[0]!.pattern).toEqual(pattern)
			expect(patternToText(editableVariant({ ...variant, pattern }).pattern)).toBe(
				patternToEditorText(pattern)
			)
		}
	)

	it("uses the same normalization when processing a real webview variant change", async () => {
		const { project, bundle, message } = await setup(
			i18next,
			{ greetingTitle: "Hi <b>{{time}}</b>" },
			i18nextSettings
		)
		const variant = message.variants[0]!
		await handleUpdateBundle({
			project,
			message: {
				command: "change",
				change: {
					entity: "variant",
					entityId: variant.id,
					newData: { ...variant, pattern: textToPattern("Hello <strong>{time}</strong><br/>") },
				},
			},
		})
		expect(host.notify).not.toHaveBeenCalled()
		const [updated] = await selectBundleNested(project.db).execute()
		const pattern = updated!.messages[0]!.variants[0]!.pattern
		expect(pattern.map((element) => element.type)).toEqual([
			"text",
			"markup-start",
			"expression",
			"markup-end",
			"markup-standalone",
		])
		expect(patternToText(pattern)).toBe("Hello <strong>{time}</strong><br/>")
		expect(bundle.messages[0]!.variants[0]!.pattern).toEqual(variant.pattern)
	})

	it("keeps plural variants separate and preserves the untouched variant", async () => {
		const { project, bundle, message } = await setup(
			i18next,
			{
				greetingTitle_one: "One <b>{{count}}</b>",
				greetingTitle_other: "Many <b>{{count}}</b>",
			},
			i18nextSettings
		)
		const variant = message.variants.find((entry) =>
			entry.matches.some((match) => match.type === "literal-match" && match.value === "one")
		)!
		const untouched = message.variants.find((entry) => entry.id !== variant.id)!
		const pattern = await normalizeVariantEdit({
			project,
			bundle,
			variant,
			pattern: textToPattern("Just one <strong>{count}</strong>"),
		})
		await project.db
			.updateTable("inlang_variant")
			.where("id", "=", variant.id)
			.set({ pattern })
			.execute()
		const [file] = await project.exportFiles({ pluginKey: i18next.key })
		expect(JSON.parse(new TextDecoder().decode(file!.content))).toEqual({
			greetingTitle_one: "Just one <strong>{{count}}</strong>",
			greetingTitle_other: "Many <b>{{count}}</b>",
		})
		const [updated] = await selectBundleNested(project.db).execute()
		expect(updated!.messages[0]!.variants.find((entry) => entry.id === untouched.id)).toEqual(
			untouched
		)
	})

	it("leaves markup as text when the JSON plugin treats it as text", async () => {
		const { project, bundle, message } = await setup(
			json,
			{ greetingTitle: "Hi <b>{time}</b>" },
			{ pathPattern: "./messages/{locale}.json" }
		)
		const variant = message.variants[0]!
		const pattern = await normalizeVariantEdit({
			project,
			bundle,
			variant,
			pattern: textToPattern("Hello <strong>{time}</strong><br/>"),
		})
		expect(pattern.some((element) => element.type.startsWith("markup-"))).toBe(false)
		expect(patternToText(pattern)).toBe("Hello <strong>{time}</strong><br/>")
	})

	it("does not change stored translations if the resource plugin rejects an edit", async () => {
		const { project, message } = await setup(
			i18next,
			{ greetingTitle: "Hi <b>{{time}}</b>" },
			i18nextSettings
		)
		const variant = message.variants[0]!
		project.plugins.get = async () => [
			{
				...i18next,
				exportFiles: () => {
					throw new Error("Cannot export this pattern")
				},
			},
		]
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			await handleUpdateBundle({
				project,
				message: {
					command: "change",
					change: {
						entity: "variant",
						entityId: variant.id,
						newData: { ...variant, pattern: textToPattern("Changed <b>{time}</b>") },
					},
				},
			})
			const stored = await project.db
				.selectFrom("inlang_variant")
				.selectAll()
				.where("id", "=", variant.id)
				.executeTakeFirstOrThrow()
			expect(stored.pattern).toEqual(variant.pattern)
			expect(host.notify).toHaveBeenCalledOnce()
			expect(host.notify.mock.calls[0]![0]).toContain('"common:greetingTitle" (en-US, variant')
		} finally {
			log.mockRestore()
		}
	})

	it("reports unexpected data once per variant with the translation key, locale and source path", async () => {
		const { project, bundle, message } = await setup(
			i18next,
			{ greetingTitle: "Hi <b>{{time}}</b>" },
			i18nextSettings
		)
		expect(
			collectPatternErrors([bundle], await project.settings.get(), "/workspace/project.inlang")
		).toEqual([])
		const broken = structuredClone(bundle)
		broken.messages[0]!.variants[0]!.pattern = [
			{ type: "future-node" },
			{ type: "future-node" },
		] as any
		const errors = collectPatternErrors(
			[broken],
			await project.settings.get(),
			"/workspace/project.inlang"
		)
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain('"common:greetingTitle"')
		expect(errors[0]!.message).toContain("en-US")
		expect(errors[0]!.message).toContain("/workspace/locales/en-US/common.json")
		expect(errors[0]!.message).toContain(message.variants[0]!.id)
		expect(patternToText(broken.messages[0]!.variants[0]!.pattern)).toContain(
			"Unsupported pattern element: future-node"
		)
		expect(host.notify).not.toHaveBeenCalled()
	})
})
