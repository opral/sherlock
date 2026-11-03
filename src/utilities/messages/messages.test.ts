import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { state } from "../state.js"
import {
	createMessageHtml,
	createNoMessagesFoundHtml,
	createMessagesLoadingHtml,
	createMessageWebviewProvider,
	getHtml,
	getTranslationsTableHtml,
} from "./messages.js"
import { CONFIGURATION } from "../../configuration.js"
import { selectBundleById } from "../project/selectBundleById.js"

const pollSubscribe = vi.hoisted(() => vi.fn())
const selectBundleNested = vi.hoisted(() => vi.fn())

const completedTask = async <T>(task: () => Promise<T>) => ({
	status: "completed" as const,
	value: await task(),
})

// Mocking vscode module and state module
vi.mock("vscode", () => ({
	window: {
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: vi.fn(),
		registerWebviewViewProvider: vi.fn(),
	},
	workspace: {
		onDidChangeTextDocument: vi.fn(),
		onDidChangeConfiguration: vi.fn(),
	},
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn((path: string) => ({ fsPath: path })),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	Webview: vi.fn(() => ({
		asWebviewUri: vi.fn(),
		cspSource: "cspSource",
	})),
	EventEmitter: class {
		listeners = new Set<(value: unknown) => void>()
		event = (listener: (value: unknown) => void) => {
			this.listeners.add(listener)
			return { dispose: () => this.listeners.delete(listener) }
		}
		fire = (value: unknown) => {
			for (const listener of this.listeners) listener(value)
		}
	},
	CodeActionKind: {
		QuickFix: vi.fn(),
	},
	extensions: {
		getExtension: vi.fn(() => ({
			exports: {
				context: {
					extensionUri: { fsPath: "/mocked/extension/path" },
				},
			},
		})),
	},
}))

vi.mock("../state.js", () => ({
	state: vi.fn(),
}))

vi.mock("../polling/pollQuery.js", () => ({
	pollQuery: vi.fn(() => ({ subscribe: pollSubscribe })),
}))

vi.mock("@inlang/sdk", () => ({
	selectBundleNested,
}))

vi.mock("../project/selectBundleById.js", () => ({
	selectBundleById: vi.fn(),
}))

describe("Message Webview Provider Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		selectBundleNested.mockReturnValue({
			execute: vi.fn(async () => []),
			where: vi.fn(() => ({ executeTakeFirst: vi.fn(async () => undefined) })),
		})
	})

	it("should create HTML for a message", async () => {
		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				settings: {
					get: vi.fn().mockResolvedValue({
						baseLocale: "en",
						locales: ["en", "de"],
						experimental: {
							aliases: true,
						},
					}),
				},
			},
			selectedProjectPath: "/workspace/project",
		})

		// Creating a message HTML using the mocked data
		const html = await createMessageHtml({
			bundle: {
				id: "message-id",
				declarations: [],
				messages: [
					{
						id: "message-id",
						bundle_id: "bundle-id",
						locale: "en",
						selectors: [],
						variants: [
							{
								id: "variant-id",
								matches: [],
								message_id: "message-id",
								pattern: [{ type: "text", value: "Hello" }],
							},
						],
					},
				],
			},
			isHighlighted: false,
			workspaceFolder: {
				uri: { fsPath: "/workspace/project" },
			} as vscode.WorkspaceFolder,
		})

		// Validating that the created HTML contains the expected content
		expect(html).toContain("message-id")
		expect(html).toContain("Hello")
	})

	it("should handle cases where settings are not available", async () => {
		// Mocking state to return a project with no specific settings
		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				settings: {
					get: vi.fn().mockResolvedValue({
						locales: [], // Handling undefined locales case
					}),
				},
			},
			selectedProjectPath: "/workspace/project",
		})

		// Creating a message HTML without aliases enabled
		const html = await createMessageHtml({
			bundle: {
				declarations: [],
				id: "message-id",
				messages: [],
			},
			isHighlighted: false,
			workspaceFolder: {
				uri: { fsPath: "/workspace/project" },
			} as vscode.WorkspaceFolder,
		})

		// Validating that the created HTML does not contain aliasValue since aliases are disabled
		expect(html).toContain("message-id")
		expect(html).not.toContain("aliasValue")
	})

	it("should create a translations table for a message", async () => {
		// Mocking state with valid locales
		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				settings: {
					get: vi.fn().mockResolvedValue({
						baseLocale: "en",
						locales: ["en", "de"], // Configured locales
					}),
				},
			},
			selectedProjectPath: "/workspace/project",
		})

		// Creating a translations table HTML
		const html = await getTranslationsTableHtml({
			bundle: {
				id: "message-id",
				declarations: [],
				messages: [
					{
						id: "message-id",
						bundle_id: "bundle-id",
						locale: "en",
						selectors: [],
						variants: [
							{
								id: "variant-id",
								matches: [],
								message_id: "message-id",
								pattern: [{ type: "text", value: "Hello" }],
							},
						],
					},
					// German translation is missing (to test the "missing" message)
				],
			},
			workspaceFolder: {
				uri: { fsPath: "/workspace/project" },
			} as vscode.WorkspaceFolder,
		})

		// Update assertions to match new HTML structure
		expect(html).toContain('<span class="languageTag"><strong>en</strong></span>')
		expect(html).toContain("<button onclick=\"openEditorView('message-id')\">Hello</button>")
		expect(html).toContain('<span class="languageTag"><strong>de</strong></span>')
		expect(html).toContain("[missing]")
		expect(html).not.toContain("codicon-sparkle")
		expect(html).toContain("codicon-edit")
	})

	it("should handle cases where there are no translations", async () => {
		// Mocking state with valid locales but no translations available
		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				settings: {
					get: vi.fn().mockResolvedValue({
						baseLocale: "en",
						locales: ["en", "de"], // Configured locales
					}),
				},
			},
			selectedProjectPath: "/workspace/project",
		})

		// Creating a translations table HTML with no translations available
		const html = await getTranslationsTableHtml({
			bundle: {
				declarations: [],
				id: "message-id",
				messages: [], // No messages for any locale
			},
			workspaceFolder: {
				uri: { fsPath: "/workspace/project" },
			} as vscode.WorkspaceFolder,
		})

		// Validate that the HTML indicates missing translations for each locale
		expect(html).toContain("en") // English section should still appear
		expect(html).toContain("[missing]") // Missing English translation
		expect(html).toContain("de") // German section should appear
		expect(html).toContain("[missing]") // Missing German translation
	})

	it("keeps missing translations searchable before their details are expanded", async () => {
		const html = await createMessageHtml({
			bundle: { id: "missing", declarations: [], messages: [] },
			isHighlighted: false,
			locales: ["en", "de"],
			lazy: true,
			projectPath: "/workspace/project.inlang",
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
		})
		expect(html).toContain('data-search-text=" [missing]"')
		expect(html).not.toContain('<div class="table">')
	})

	it("should create 'No Messages Found' HTML", () => {
		// Creating HTML for when no messages are found
		const html = createNoMessagesFoundHtml()

		// Validating that the created HTML contains the expected content
		expect(html).toContain("No messages found")
	})

	it("should create 'Loading Messages' HTML", () => {
		// Creating HTML for when messages are loading
		const html = createMessagesLoadingHtml()

		// Validating that the created HTML contains the expected content
		expect(html).toContain("Loading messages...")
	})

	it("indexes all configured translations without eagerly rendering hidden locale tables", async () => {
		const locales = Array.from({ length: 13 }, (_, i) => `locale-${i}`)
		const messageBundle = {
			id: "searchable",
			declarations: [],
			messages: locales.map((locale, index) => ({
				id: locale,
				bundle_id: "searchable",
				locale,
				selectors: [],
				variants: [
					{
						id: `v-${index}`,
						message_id: locale,
						matches: [],
						pattern: [
							{
								type: "text",
								value: index === 12 ? 'Last "quoted" <needle>' : `Translation in ${locale}`,
							},
						],
					},
				],
			})),
		}
		const args = {
			bundle: messageBundle,
			locales,
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
			projectPath: "/workspace/project.inlang",
			isHighlighted: false,
		}
		const eager = await createMessageHtml(args as never)
		const lazy = await createMessageHtml({ ...args, lazy: true } as never)
		expect(lazy).toContain('data-loaded="false"')
		expect(lazy).toContain('data-search-text="Translation in locale-0')
		expect(lazy).toContain("Last &quot;quoted&quot; &lt;needle&gt;")
		expect(lazy).not.toContain('<div class="table">')
		expect(lazy.length).toBeLessThan(eager.length / 3)
	})

	describe("rendering polled messages", () => {
		const bundle = (id: string) => ({ id, declarations: [], messages: [] })
		const project = () => ({
			db: {},
			plugins: { get: vi.fn(async () => []) },
			settings: { get: vi.fn(async () => ({ locales: ["en", "de"] })) },
		})
		const deferred = <T>() => {
			let resolve!: (value: T) => void
			const promise = new Promise<T>((done) => (resolve = done))
			return { promise, resolve }
		}
		const harness = (initialProject = project()) => {
			const subscribers: Array<(bundles: ReturnType<typeof bundle>[]) => void> = []
			pollSubscribe.mockImplementation((listener) => {
				subscribers.push(listener)
				return { unsubscribe: vi.fn(async () => undefined) }
			})
			const subscriptions: vscode.Disposable[] = []
			const provider = createMessageWebviewProvider({
				workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
				extensionUri: { fsPath: "/extension" } as vscode.Uri,
				subscriptions,
			})
			const refresh = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.lastCall![0]
			const bindings: Array<{ dispose: () => unknown }> = []
			const bind = (nextProject = initialProject) => {
				bindings.push(
					provider.bindProject({
						path: "/workspace/project.inlang",
						project: nextProject,
						runTask: completedTask,
					} as any)
				)
			}
			const views: Array<{ dispose: () => void }> = []
			const open = () => {
				let dispose!: () => void
				let receive!: (message: { command: string }) => void
				const view = {
					onDidDispose: vi.fn((callback) => (dispose = callback)),
					webview: {
						postMessage: vi.fn(async (_message: unknown) => true),
						onDidReceiveMessage: vi.fn((callback) => {
							receive = callback
							return { dispose: vi.fn() }
						}),
						asWebviewUri: vi.fn((uri) => uri),
						cspSource: "test-csp",
						options: {},
						html: "",
					},
				}
				provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as never, {} as never)
				const result = {
					view,
					dispose: () => dispose(),
					receive: (command: string, details: Record<string, unknown> = {}) =>
						receive({ command, ...details }),
				}
				views.push(result)
				return result
			}
			bind()
			return {
				bind,
				open,
				refresh: () => refresh({} as vscode.ConfigurationChangeEvent),
				publish: async (data: ReturnType<typeof bundle>[], index = subscribers.length - 1) => {
					await vi.waitFor(() => expect(subscribers.length).toBeGreaterThan(index))
					subscribers[index]!(data)
				},
				waitForSubscriptions: (count: number) =>
					vi.waitFor(() => expect(subscribers).toHaveLength(count)),
				dispose: async () => {
					for (const view of views) view.dispose()
					for (const binding of bindings) await binding.dispose()
					for (const subscription of subscriptions) subscription?.dispose()
				},
			}
		}

		it("loads translations on expansion from the polled snapshot and ignores stale requests", async () => {
			const activeProject = project()
			const app = harness(activeProject)
			try {
				const { view, receive } = app.open()
				await app.waitForSubscriptions(1)
				await app.publish([
					{
						id: "welcome",
						declarations: [],
						messages: [
							{
								id: "welcome-en",
								bundle_id: "welcome",
								locale: "en",
								selectors: [],
								variants: [
									{
										id: "v",
										message_id: "welcome-en",
										matches: [],
										pattern: [{ type: "text", value: "Expanded translation" }],
									},
								],
							},
						],
					},
				] as never)
				await vi.waitFor(() => expect(view.webview.html).toContain('data-message-id="welcome"'))
				const revision = Number(view.webview.html.match(/const renderRevision = (\d+);/)![1])
				expect(view.webview.html).not.toContain('<span class="message"><button')
				receive("expandMessage", { bundleId: "welcome", revision: revision - 1 })
				expect(activeProject.settings.get).toHaveBeenCalledTimes(1)
				receive("expandMessage", { bundleId: "welcome", revision })
				await vi.waitFor(() => expect(view.webview.postMessage).toHaveBeenCalledTimes(1))
				expect(view.webview.postMessage).toHaveBeenCalledWith({
					command: "messageDetails",
					bundleId: "welcome",
					revision,
					html: expect.stringContaining("Expanded translation"),
				})
				expect(selectBundleById).not.toHaveBeenCalled()
				expect(selectBundleNested).not.toHaveBeenCalled()
			} finally {
				await app.dispose()
			}
		})

		it("does not post expanded translations to a disposed webview", async () => {
			const activeProject = project()
			const app = harness(activeProject)
			const settings = deferred<{ locales: string[] }>()
			try {
				const { view, receive, dispose } = app.open()
				await app.waitForSubscriptions(1)
				await app.publish([bundle("welcome")])
				await vi.waitFor(() => expect(view.webview.html).toContain('data-message-id="welcome"'))
				const revision = Number(view.webview.html.match(/const renderRevision = (\d+);/)![1])
				activeProject.settings.get.mockImplementationOnce(() => settings.promise)
				receive("expandMessage", { bundleId: "welcome", revision })
				await vi.waitFor(() => expect(activeProject.settings.get).toHaveBeenCalledTimes(2))
				dispose()
				settings.resolve({ locales: ["en", "de"] })
				await new Promise<void>((resolve) => setImmediate(resolve))
				expect(view.webview.postMessage).not.toHaveBeenCalled()
			} finally {
				settings.resolve({ locales: [] })
				await app.dispose()
			}
		})

		it("renders polled highlights once and ignores unknown references without extra SQL", async () => {
			const activeProject = project()
			activeProject.plugins.get.mockResolvedValue([
				{
					meta: {
						"app.inlang.ideExtension": {
							messageReferenceMatchers: [
								vi.fn(async () => [
									{ bundleId: "welcome" },
									{ bundleId: "welcome" },
									{ bundleId: "unknown" },
								]),
							],
						},
					},
				},
			] as never)
			const app = harness(activeProject)
			try {
				const { view } = app.open()
				await app.waitForSubscriptions(1)
				await app.publish([bundle("welcome")])
				await vi.waitFor(() => expect(view.webview.html).toContain('class="highlighted-section"'))
				expect(view.webview.html.match(/data-message-id="welcome"/g)).toHaveLength(2)
				expect(view.webview.html).not.toContain('data-message-id="unknown"')
				expect(selectBundleById).not.toHaveBeenCalled()
				expect(selectBundleNested).not.toHaveBeenCalled()
			} finally {
				await app.dispose()
			}
		})

		it("renders all 611 bundles using one settings read for the completed render", async () => {
			const activeProject = project()
			const app = harness(activeProject)
			try {
				const { view } = app.open()
				await app.waitForSubscriptions(1)
				await app.publish(Array.from({ length: 611 }, (_, index) => bundle(`message-${index}`)))
				await vi.waitFor(() => expect(view.webview.html).toContain('data-message-id="message-610"'))
				expect(view.webview.html.match(/data-message-id=/g)).toHaveLength(611)
				expect(view.webview.html).not.toContain("Loading messages...")
				expect(activeProject.settings.get).toHaveBeenCalledTimes(1)
			} finally {
				await app.dispose()
			}
		})

		it("continues rendering after binding another project and reopening the view", async () => {
			const app = harness()
			try {
				const first = app.open()
				await app.waitForSubscriptions(1)
				await app.publish([bundle("first-project")])
				await vi.waitFor(() =>
					expect(first.view.webview.html).toContain('data-message-id="first-project"')
				)
				app.bind(project())
				app.refresh()
				await app.waitForSubscriptions(2)
				await app.publish([bundle("second-project")])
				await vi.waitFor(
					() => expect(first.view.webview.html).toContain('data-message-id="second-project"'),
					{ timeout: 2000 }
				)
				expect(first.view.webview.html).not.toContain('data-message-id="first-project"')
				first.dispose()
				const reopened = app.open()
				await app.waitForSubscriptions(3)
				await app.publish([bundle("reopened")])
				await vi.waitFor(
					() => expect(reopened.view.webview.html).toContain('data-message-id="reopened"'),
					{ timeout: 2000 }
				)
			} finally {
				await app.dispose()
			}
		})

		it("prevents an older asynchronous render from overwriting newer content", async () => {
			const activeProject = project()
			const oldSettings = deferred<{ locales: string[] }>()
			activeProject.settings.get.mockReturnValueOnce(oldSettings.promise)
			const app = harness(activeProject)
			try {
				const { view } = app.open()
				await app.waitForSubscriptions(1)
				await app.publish([bundle("old-message")])
				await vi.waitFor(() => expect(activeProject.settings.get).toHaveBeenCalledTimes(1))
				await app.publish([bundle("new-message")])
				await vi.waitFor(
					() => expect(view.webview.html).toContain('data-message-id="new-message"'),
					{ timeout: 2000 }
				)
				oldSettings.resolve({ locales: ["en"] })
				await new Promise((resolve) => setTimeout(resolve, 0))
				expect(view.webview.html).toContain('data-message-id="new-message"')
				expect(view.webview.html).not.toContain('data-message-id="old-message"')
			} finally {
				oldSettings.resolve({ locales: [] })
				await app.dispose()
			}
		})

		it("retries a failed settings read with the unchanged polled snapshot", async () => {
			const activeProject = project()
			activeProject.settings.get.mockRejectedValueOnce(new Error("temporarily unavailable"))
			const app = harness(activeProject)
			try {
				const { view, receive } = app.open()
				await app.waitForSubscriptions(1)
				await app.publish([bundle("retry-message")])
				await vi.waitFor(() => expect(view.webview.html).toContain("Unable to load messages."))
				expect(view.webview.html).toContain("retryMessages")
				receive("retryMessages")
				await vi.waitFor(() =>
					expect(view.webview.html).toContain('data-message-id="retry-message"')
				)
				expect(activeProject.settings.get).toHaveBeenCalledTimes(2)
				expect(pollSubscribe).toHaveBeenCalledTimes(1)
			} finally {
				await app.dispose()
			}
		})
	})

	it("replaces polling when reload creates a new project at the same path", async () => {
		const firstSubscription = { unsubscribe: vi.fn(async () => undefined) }
		const secondSubscription = { unsubscribe: vi.fn(async () => undefined) }
		pollSubscribe.mockReturnValueOnce(firstSubscription).mockReturnValueOnce(secondSubscription)
		const firstProject = { db: {}, plugins: { get: vi.fn(async () => []) } }
		const secondProject = { db: {}, plugins: { get: vi.fn(async () => []) } }
		const provider = createMessageWebviewProvider({
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			subscriptions: [],
		})
		const firstBinding = provider.bindProject({
			path: "/workspace/project.inlang",
			project: firstProject,
			runTask: completedTask,
		} as any)
		provider.resolveWebviewView(
			{
				onDidDispose: vi.fn(),
				webview: {
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn((uri) => uri),
					cspSource: "test-csp",
					options: {},
					html: "",
				},
			} as unknown as vscode.WebviewView,
			{} as never,
			{} as never
		)
		await vi.waitFor(() => expect(pollSubscribe).toHaveBeenCalledTimes(1))

		provider.bindProject({
			path: "/workspace/project.inlang",
			project: secondProject,
			runTask: completedTask,
		} as any)
		await Promise.resolve()
		expect(pollSubscribe).toHaveBeenCalledTimes(1)
		CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.fire(undefined)
		await firstBinding.dispose()

		await vi.waitFor(() => expect(pollSubscribe).toHaveBeenCalledTimes(2))
		expect(firstSubscription.unsubscribe).toHaveBeenCalledTimes(1)
		expect(secondSubscription.unsubscribe).not.toHaveBeenCalled()
	})

	it("registers global listeners once and suspends polling while the view is disposed", async () => {
		const firstSubscription = { unsubscribe: vi.fn(async () => undefined) }
		const secondSubscription = { unsubscribe: vi.fn(async () => undefined) }
		pollSubscribe.mockReturnValueOnce(firstSubscription).mockReturnValueOnce(secondSubscription)
		const provider = createMessageWebviewProvider({
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			subscriptions: [],
		})
		provider.bindProject({
			path: "/workspace/project.inlang",
			project: { db: {}, plugins: { get: vi.fn(async () => []) } },
			runTask: completedTask,
		} as any)
		let disposeFirstView!: () => void
		const createView = (captureDispose?: (callback: () => void) => void) =>
			({
				onDidDispose: vi.fn((callback) => captureDispose?.(callback)),
				webview: {
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn((uri) => uri),
					cspSource: "test-csp",
					options: {},
					html: "",
				},
			}) as unknown as vscode.WebviewView

		provider.resolveWebviewView(
			createView((callback) => (disposeFirstView = callback)),
			{} as never,
			{} as never
		)
		await vi.waitFor(() => expect(pollSubscribe).toHaveBeenCalledTimes(1))
		disposeFirstView()
		await vi.waitFor(() => expect(firstSubscription.unsubscribe).toHaveBeenCalledTimes(1))

		provider.resolveWebviewView(createView(), {} as never, {} as never)
		await vi.waitFor(() => expect(pollSubscribe).toHaveBeenCalledTimes(2))
		expect(vscode.window.onDidChangeActiveTextEditor).toHaveBeenCalledTimes(1)
		expect(vscode.workspace.onDidChangeTextDocument).toHaveBeenCalledTimes(1)
		expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalledTimes(1)
	})

	it("does not let late disposal of an old view tear down its replacement", async () => {
		const subscription = { unsubscribe: vi.fn(async () => undefined) }
		pollSubscribe.mockReturnValueOnce(subscription)
		const provider = createMessageWebviewProvider({
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			subscriptions: [],
		})
		provider.bindProject({
			path: "/workspace/project.inlang",
			project: { db: {}, plugins: { get: vi.fn(async () => []) } },
			runTask: completedTask,
		} as any)
		let disposeFirstView!: () => void
		let disposeSecondView!: () => void
		const createView = (captureDispose: (callback: () => void) => void) =>
			({
				onDidDispose: vi.fn(captureDispose),
				webview: {
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn((uri) => uri),
					cspSource: "test-csp",
					options: {},
					html: "",
				},
			}) as unknown as vscode.WebviewView

		provider.resolveWebviewView(
			createView((callback) => (disposeFirstView = callback)),
			{} as never,
			{} as never
		)
		await vi.waitFor(() => expect(pollSubscribe).toHaveBeenCalledTimes(1))
		provider.resolveWebviewView(
			createView((callback) => (disposeSecondView = callback)),
			{} as never,
			{} as never
		)

		disposeFirstView()
		await Promise.resolve()
		expect(subscription.unsubscribe).not.toHaveBeenCalled()

		disposeSecondView()
		await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledTimes(1))
	})

	it("stops polling when VS Code cancels webview resolution", async () => {
		const subscription = { unsubscribe: vi.fn(async () => undefined) }
		pollSubscribe.mockReturnValueOnce(subscription)
		const provider = createMessageWebviewProvider({
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			subscriptions: [],
		})
		provider.bindProject({
			path: "/workspace/project.inlang",
			project: { db: {}, plugins: { get: vi.fn(async () => []) } },
			runTask: completedTask,
		} as any)
		let cancel!: () => void
		provider.resolveWebviewView(
			{
				onDidDispose: vi.fn(),
				webview: {
					onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
					asWebviewUri: vi.fn((uri) => uri),
					cspSource: "test-csp",
					options: {},
					html: "",
				},
			} as unknown as vscode.WebviewView,
			{} as never,
			{
				onCancellationRequested: vi.fn((callback) => {
					cancel = callback
					return { dispose: vi.fn() }
				}),
			} as unknown as vscode.CancellationToken
		)
		await vi.waitFor(() => expect(pollSubscribe).toHaveBeenCalledTimes(1))

		cancel()

		await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledTimes(1))
	})

	it("should create the complete webview HTML", () => {
		// Mocking the context and webview
		const context = {
			extensionUri: vscode.Uri.file("/path/to/extension"),
		} as vscode.ExtensionContext

		// @ts-expect-error
		const webview = new vscode.Webview()

		// Creating the complete webview HTML
		const html = getHtml({
			mainContent: "<div>Main Content</div>",
			webview,
			extensionUri: context.extensionUri,
		})

		// Validating that the webview HTML contains the expected content
		expect(html).toContain("<div>Main Content</div>")
		expect(html).toContain("Content-Security-Policy")
	})
})
