import * as fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import i18next from "@inlang/plugin-i18next"
import json from "@inlang/plugin-json"
import {
	loadProjectFromDirectory,
	loadProjectInMemory,
	newProject,
	selectBundleNested,
	type InlangPlugin,
	type InlangProject,
} from "@inlang/sdk"

const watcherHost = vi.hoisted(() => ({ watchers: [] as Array<{ change?: () => void }> }))
vi.mock("vscode", () => ({
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	RelativePattern: class {
		constructor(
			public base: string,
			public pattern: string
		) {}
	},
	workspace: {
		fs: { readFile: (uri: { fsPath: string }) => fsPromises.readFile(uri.fsPath) },
		createFileSystemWatcher: () => {
			const callbacks: { change?: () => void } = {}
			watcherHost.watchers.push(callbacks)
			return {
				onDidChange: (callback: () => void) => {
					callbacks.change = callback
				},
				onDidCreate: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}
		},
	},
}))
vi.mock("../../src/configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_EDITOR_VIEW_CHANGE: { fire: vi.fn() },
		},
	},
}))
vi.mock("../../src/utilities/messages/msg.js", () => ({ msg: vi.fn() }))
import { createProjectResourceSynchronization } from "../../src/utilities/project/projectResourceSynchronization.js"
import { clearOmittedEmptyJsonResources } from "../../src/utilities/project/clearEmptyJsonResources.js"
import { deleteVariant } from "../../src/utilities/editor/helper/deleteVariant.js"
import { deleteBundleNested } from "../../src/utilities/editor/helper/deleteBundleNested.js"

const projects: InlangProject[] = []
const directories: string[] = []
afterEach(async () => {
	vi.useRealTimers()
	watcherHost.watchers.length = 0
	await Promise.all(projects.splice(0).map((project) => project.close()))
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => fsPromises.rm(directory, { recursive: true, force: true }))
	)
})

async function setup(
	plugin: InlangPlugin,
	pathPattern: string | Record<string, string>,
	resources: Array<{ locale: string; values: Record<string, string>; namespace?: string }>
) {
	const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "sherlock-empty-resource-"))
	directories.push(directory)
	const projectPath = path.join(directory, "project.inlang")
	await fsPromises.mkdir(projectPath)
	const project = await loadProjectInMemory({
		blob: await newProject({
			settings: {
				baseLocale: "en",
				locales: ["en", "de"],
				modules: [],
				[plugin.key]: { pathPattern },
			},
		}),
		providePlugins: [plugin],
	})
	projects.push(project)
	await project.importFiles({
		pluginKey: plugin.key,
		files: resources.map((resource) => ({
			locale: resource.locale,
			content: new TextEncoder().encode(JSON.stringify(resource.values)),
			toBeImportedFilesMetadata: resource.namespace ? { namespace: resource.namespace } : undefined,
		})),
	})
	const synchronization = createProjectResourceSynchronization()
	await synchronization.save(project, projectPath)
	return {
		project,
		directory,
		projectPath,
		synchronization,
		save: () => synchronization.save(project, projectPath),
		async reload(providePlugin: InlangPlugin = plugin) {
			const reloaded = await loadProjectFromDirectory({
				path: projectPath,
				fs,
				providePlugins: [providePlugin],
			})
			projects.push(reloaded)
			return selectBundleNested(reloaded.db).execute()
		},
	}
}

describe("deleting the last entry from a JSON resource", () => {
	it.each([
		["last variant", i18next, { greeting: "Hello {{name}}" }],
		["last zero aliases", i18next, { greeting_zero: "None {{name}}" }],
		["last JSON variant", json, { greeting: "Hello {name}" }],
	] as const)(
		"persists %s deletion and reloads without resurrection",
		async (_name, plugin, values) => {
			const fixture = await setup(plugin, "./messages/{locale}.json", [{ locale: "en", values }])
			const [bundle] = await selectBundleNested(fixture.project.db).execute()
			expect(
				await deleteVariant({
					project: fixture.project,
					variantId: bundle!.messages[0]!.variants[0]!.id,
				})
			).toBe(true)
			await fixture.save()
			expect(
				JSON.parse(
					await fsPromises.readFile(path.join(fixture.directory, "messages/en.json"), "utf8")
				)
			).toEqual({})
			expect(await fixture.reload()).toEqual([])
			await expect(
				fsPromises.stat(path.join(fixture.directory, "messages/de.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
		}
	)

	it("clears a deleted last bundle while another locale resource survives", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { removed: "Hello" } },
			{ locale: "de", values: { retained: "Hallo" } },
		])
		const dePath = path.join(fixture.directory, "messages/de.json")
		const before = await fsPromises.readFile(dePath, "utf8")
		await deleteBundleNested({ db: fixture.project.db, bundleId: "removed" })
		await fixture.save()
		expect(
			await fsPromises.readFile(path.join(fixture.directory, "messages/en.json"), "utf8")
		).toBe("{}\n")
		expect(await fsPromises.readFile(dePath, "utf8")).toBe(before)
		expect((await fixture.reload()).map((bundle) => bundle.id)).toEqual(["retained"])
	})

	it("clears an emptied namespace while preserving another namespace", async () => {
		const fixture = await setup(
			i18next,
			{
				common: "./messages/{locale}/common.json",
				admin: "./messages/{locale}/admin.json",
			},
			[
				{ locale: "en", namespace: "common", values: { greeting_zero: "None" } },
				{ locale: "en", namespace: "admin", values: { retained: "Admin" } },
			]
		)
		const common = (await selectBundleNested(fixture.project.db).execute()).find(
			(bundle) => bundle.id === "common:greeting"
		)!
		const retainedPath = path.join(fixture.directory, "messages/en/admin.json")
		const before = await fsPromises.readFile(retainedPath, "utf8")
		await deleteVariant({
			project: fixture.project,
			variantId: common.messages[0]!.variants[0]!.id,
		})
		await fixture.save()
		expect(
			await fsPromises.readFile(path.join(fixture.directory, "messages/en/common.json"), "utf8")
		).toBe("{}\n")
		expect(await fsPromises.readFile(retainedPath, "utf8")).toBe(before)
		expect((await fixture.reload()).map((bundle) => bundle.id)).toEqual(["admin:retained"])
	})

	it("preserves CRLF formatting while clearing all old translation keys", async () => {
		const fixture = await setup(json, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const resourcePath = path.join(fixture.directory, "messages/en.json")
		await fsPromises.writeFile(
			resourcePath,
			'{\r\n  "$schema": "https://example.test/schema",\r\n  "greeting": "Hello"\r\n}\r\n'
		)
		const loaded = await loadProjectFromDirectory({
			path: fixture.projectPath,
			fs,
			providePlugins: [json],
		})
		projects.push(loaded)
		for (const bundle of await selectBundleNested(loaded.db).execute())
			await deleteBundleNested({ db: loaded.db, bundleId: bundle.id })
		await fixture.synchronization.save(loaded, fixture.projectPath)
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe("{}\r\n")
		expect(await fixture.reload()).toEqual([])
	})

	it("never clears generic plugin resources or files the SDK explicitly wrote", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const resourcePath = path.join(fixture.directory, "messages/en.json")
		await deleteBundleNested({ db: fixture.project.db, bundleId: "greeting" })
		const before = await fsPromises.readFile(resourcePath, "utf8")
		await clearOmittedEmptyJsonResources({
			project: fixture.project,
			projectPath: fixture.projectPath,
			fileSystem: fsPromises,
			exports: new Map([
				[
					i18next.key,
					{
						existingFiles: [
							{
								path: "./messages/en.json",
								locale: "en",
								content: new TextEncoder().encode(before),
								imported: true,
							},
						],
						exportedFiles: [
							{ name: "en.json", locale: "en", content: new TextEncoder().encode(before) },
						],
					},
				],
			]),
		})
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe(before)
		fixture.project.plugins.get = async () => [{ ...i18next, key: "plugin.example" }]
		await clearOmittedEmptyJsonResources({
			project: fixture.project,
			projectPath: fixture.projectPath,
			fileSystem: fsPromises,
			exports: new Map([
				[
					"plugin.example",
					{
						existingFiles: [
							{
								path: "./messages/en.json",
								locale: "en",
								content: new TextEncoder().encode(before),
								imported: true,
							},
						],
						exportedFiles: [],
					},
				],
			]),
		})
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe(before)
	})

	it.each([false, true])(
		"preserves an unused base source override (namespaced=%s)",
		async (namespaced) => {
			const fixture = await setup(
				i18next,
				namespaced ? { common: "./messages/{locale}/common.json" } : "./messages/{locale}.json",
				[
					{
						locale: "en",
						namespace: namespaced ? "common" : undefined,
						values: { greeting: "Hello" },
					},
				]
			)
			const settings = await fixture.project.settings.get()
			const override = "./base-source.json"
			await fixture.project.settings.set({
				...settings,
				[i18next.key]: {
					...(settings[i18next.key] as Record<string, unknown>),
					sourceLanguageFilePath: namespaced ? { common: override } : override,
				},
			})
			const overridePath = path.join(fixture.directory, "base-source.json")
			await fsPromises.writeFile(overridePath, '{"greeting":"Hello"}')
			const [bundle] = await selectBundleNested(fixture.project.db).execute()
			await deleteVariant({
				project: fixture.project,
				variantId: bundle!.messages[0]!.variants[0]!.id,
			})
			await fixture.save()
			expect(await fsPromises.readFile(overridePath, "utf8")).toBe('{"greeting":"Hello"}')
			expect(await fixture.reload()).toEqual([])
		}
	)

	it("preserves a source file when import errors may explain the empty graph", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const resourcePath = path.join(fixture.directory, "messages/en.json")
		const before = await fsPromises.readFile(resourcePath, "utf8")
		await deleteBundleNested({ db: fixture.project.db, bundleId: "greeting" })
		fixture.project.errors.get = async () => [new Error("A resource could not be imported")]
		await fixture.save()
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe(before)
	})

	it("acknowledges the empty resource write without scheduling an external reload", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const owned: Array<{ dispose(): unknown }> = []
		const reconcile = vi.fn()
		await fixture.synchronization.watch({
			project: fixture.project,
			path: fixture.projectPath,
			own: (resource: { dispose(): unknown }) => {
				owned.push(resource)
				return true
			},
			runTask: async (task: () => Promise<unknown>) => ({
				status: "completed",
				value: await task(),
			}),
			requestReconciliation: reconcile,
		} as never)
		const [bundle] = await selectBundleNested(fixture.project.db).execute()
		await deleteVariant({
			project: fixture.project,
			variantId: bundle!.messages[0]!.variants[0]!.id,
		})
		await fixture.save()
		vi.useFakeTimers()
		for (const watcher of watcherHost.watchers) watcher.change?.()
		await vi.advanceTimersByTimeAsync(200)
		expect(reconcile).not.toHaveBeenCalled()
		for (const resource of owned) await resource.dispose()
	})

	it("clears a base override when the plugin actually imports that path", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const overridePath = path.join(fixture.directory, "base-source.json")
		await fsPromises.writeFile(overridePath, '{"greeting":"Hello"}')
		const actualOverride = {
			...i18next,
			toBeImportedFiles: async () => [{ locale: "en", path: "./base-source.json" }],
		}
		const loaded = await loadProjectFromDirectory({
			path: fixture.projectPath,
			fs,
			providePlugins: [actualOverride],
		})
		projects.push(loaded)
		const [bundle] = await selectBundleNested(loaded.db).execute()
		await deleteVariant({ project: loaded, variantId: bundle!.messages[0]!.variants[0]!.id })
		await fixture.synchronization.save(loaded, fixture.projectPath)
		expect(await fsPromises.readFile(overridePath, "utf8")).toBe("{}")
		// The unused default resource remains outside this importer's ownership.
		expect(
			JSON.parse(
				await fsPromises.readFile(path.join(fixture.directory, "messages/en.json"), "utf8")
			)
		).toEqual({ greeting: "Hello" })
		expect(await fixture.reload(actualOverride)).toEqual([])
	})

	it("preserves externally changed source bytes without a watcher", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const resourcePath = path.join(fixture.directory, "messages/en.json")
		const external = '{"greeting":"Changed outside Sherlock"}'
		await fsPromises.writeFile(resourcePath, external)
		await deleteBundleNested({ db: fixture.project.db, bundleId: "greeting" })
		await fixture.save()
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe(external)
	})

	it("preserves files of a newly configured locale that the project never imported", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const resourcePath = path.join(fixture.directory, "messages/fr.json")
		const unrelated = '{"greeting":"Bonjour"}'
		await fsPromises.writeFile(resourcePath, unrelated)
		const settings = await fixture.project.settings.get()
		await fixture.project.settings.set({ ...settings, locales: [...settings.locales, "fr"] })
		await deleteBundleNested({ db: fixture.project.db, bundleId: "greeting" })
		await fixture.save()
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe(unrelated)
		expect(
			await fsPromises.readFile(path.join(fixture.directory, "messages/en.json"), "utf8")
		).toBe("{}\n")
	})

	it("preserves an external edit made after the SDK captured its existing-file input", async () => {
		const fixture = await setup(i18next, "./messages/{locale}.json", [
			{ locale: "en", values: { greeting: "Hello" } },
		])
		const resourcePath = path.join(fixture.directory, "messages/en.json")
		await deleteBundleNested({ db: fixture.project.db, bundleId: "greeting" })
		fixture.project.plugins.get = async () => [
			{
				...i18next,
				exportFiles: async () => {
					await fsPromises.writeFile(resourcePath, '{"greeting":"Arrived during save"}')
					return []
				},
			},
		]
		await fixture.save()
		expect(await fsPromises.readFile(resourcePath, "utf8")).toBe(
			'{"greeting":"Arrived during save"}'
		)
	})
})
