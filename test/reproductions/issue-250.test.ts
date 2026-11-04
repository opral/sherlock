// Run with SHERLOCK_ISSUE_250_KEYS=2845 to match the report's 35 namespaces / 13 locales.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { expect, it, vi } from "vitest"
import { selectBundleNested, type InlangProject } from "@inlang/sdk"
import {
	createProjectSessionLifecycle,
	type ProjectSession,
} from "../../src/utilities/project/projectSession.js"
import { createProjectResourceSynchronization } from "../../src/utilities/project/projectResourceSynchronization.js"

// Keep the real SDK, resource reads, and session replacement lifecycle. Only the
// VS Code boundary is replaced; workspace.fs uses FileNotFound rather than ENOENT.
vi.mock("vscode", () => ({
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	RelativePattern: class {},
	workspace: {
		fs: {
			readFile: async ({ fsPath }: { fsPath: string }) => {
				try {
					return await fs.readFile(fsPath)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						throw Object.assign(new Error("File not found"), { code: "FileNotFound" })
					}
					throw error
				}
			},
		},
		createFileSystemWatcher: () => ({
			onDidCreate: vi.fn(),
			onDidChange: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

it("keeps a sparse i18next project and its editor alive while idle (#250)", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-issue-250-"))
	const projectPath = path.join(root, "project.inlang")
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
	const namespaces = Array.from({ length: 35 }, (_, index) => `namespace_${index}`)
	const keyCount = Number(process.env.SHERLOCK_ISSUE_250_KEYS ?? 70)
	const synchronization = createProjectResourceSynchronization()
	const load = vi.fn((projectPath: string) => synchronization.load(projectPath))
	const errors: unknown[] = []
	let active: ProjectSession<InlangProject> | undefined
	const editor = { dispose: vi.fn() }
	const lifecycle = createProjectSessionLifecycle({
		loadProject: load,
		prepareSession: async (session) => ({
			activate() {},
			afterPreviousDisposed: () =>
				synchronization.watch(session, { onError: (error) => errors.push(error) }),
		}),
		setActiveSession: (session) => {
			active = session
		},
		onError: (error) => errors.push(error),
	})
	try {
		await fs.mkdir(projectPath)
		const pluginPath = path.join(root, "i18next.js")
		await fs.copyFile(createRequire(import.meta.url).resolve("@inlang/plugin-i18next"), pluginPath)
		await fs.writeFile(
			path.join(projectPath, "settings.json"),
			JSON.stringify({
				baseLocale: locales[0],
				locales,
				modules: [pluginPath],
				"plugin.inlang.i18next": {
					pathPattern: Object.fromEntries(
						namespaces.map((namespace) => [namespace, `./translations/{locale}/${namespace}.json`])
					),
					contextValues: [],
					variableReferencePattern: ["{{", "}}"],
				},
			})
		)
		for (const locale of locales) {
			await fs.mkdir(path.join(root, "translations", locale), { recursive: true })
			for (const [namespaceIndex, namespace] of namespaces.entries()) {
				// A configured locale need not have a file in every namespace.
				if (locale === "zh-CN" && namespaceIndex === 34) continue
				const values: Record<string, string> = {}
				for (let index = namespaceIndex; index < keyCount; index += namespaces.length)
					values[`key_${index}`] = `${locale} translation ${index}`
				await fs.writeFile(
					path.join(root, "translations", locale, `${namespace}.json`),
					JSON.stringify(values)
				)
			}
		}
		expect(await lifecycle.replaceProject(projectPath)).toEqual({ status: "committed" })
		const original = active
		expect(await selectBundleNested(original!.project.db).execute()).toHaveLength(keyCount)
		expect(await original!.project.errors.get()).toEqual([])
		expect(active?.own(editor)).toBe(true)
		// Reconciliation is scheduled after 150ms; idle watcher setup must not replace the session.
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(load).toHaveBeenCalledTimes(1)
		expect(active).toBe(original)
		expect(editor.dispose).not.toHaveBeenCalled()
		expect(errors).toEqual([])
	} finally {
		await lifecycle.dispose()
		await fs.rm(root, { recursive: true, force: true })
	}
}, 30_000)
