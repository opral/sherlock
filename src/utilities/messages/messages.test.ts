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

	it("selects an exact highlighted bundle through the shared exact-ID operation", async () => {
		const bundle = { id: "welcome", declarations: [], messages: [] }
		vi.mocked(selectBundleById).mockResolvedValue(bundle as never)
		const project = {
			db: {},
			plugins: {
				get: vi.fn(async () => [
					{
						meta: {
							"app.inlang.ideExtension": {
								messageReferenceMatchers: [vi.fn(async () => [{ bundleId: "welcome" }])],
							},
						},
					},
				]),
			},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const subscriptions: vscode.Disposable[] = []
		const provider = createMessageWebviewProvider({
			workspaceFolder: { uri: { fsPath: "/workspace" } } as vscode.WorkspaceFolder,
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			subscriptions,
		})
		const binding = provider.bindProject({
			path: "/workspace/project.inlang",
			project,
			runTask: completedTask,
		} as any)
		let disposeView!: () => void

		provider.resolveWebviewView(
			{
				onDidDispose: vi.fn((callback) => (disposeView = callback)),
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

		await vi.waitFor(() => expect(selectBundleById).toHaveBeenCalledWith(project, "welcome"))
		disposeView()
		await binding.dispose()
		for (const subscription of subscriptions) subscription?.dispose()
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
