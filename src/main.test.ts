import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import fg from "fast-glob"
import { activate, deactivate, discoverProjectsInWorkspace, saveProject } from "./main.js"
import { state } from "./utilities/state.js"
import { handleError } from "./utilities/utils.js"
import { gettingStartedView } from "./utilities/getting-started/gettingStarted.js"
import { closestInlangProject } from "./utilities/project/closestInlangProject.js"
import { projectView } from "./utilities/project/project.js"
import { messageView } from "./utilities/messages/messages.js"
import { errorView } from "./utilities/errors/errors.js"
import { recommendationBannerView } from "./utilities/recommendation/recommendation.js"
import { getProjectRuntime } from "./utilities/project/projectRuntime.js"
import { CONFIGURATION } from "./configuration.js"
import { createProjectSessionEnvironment } from "./utilities/project/projectSessionEnvironment.js"
import { saveProjectResources } from "./utilities/project/projectResourceSynchronization.js"

const createOpenEditorViewCallback = vi.hoisted(() => vi.fn(() => vi.fn()))
const environment = vi.hoisted(() => ({
	mappedFs: { mapped: true },
	runtime: undefined as any,
	create: vi.fn(),
}))

vi.mock("vscode", () => ({
	version: "1.90.0",
	commands: {
		executeCommand: vi.fn(),
		registerCommand: vi.fn(),
	},
	workspace: {
		workspaceFolders: [],
	},
	window: {
		registerTreeDataProvider: vi.fn(),
		registerWebviewViewProvider: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	EventEmitter: class {
		fire = vi.fn()
		event = vi.fn()
	},
	ThemeIcon: class {},
	ThemeColor: class {},
	TreeItemCollapsibleState: {
		Collapsed: 0,
		None: 1,
		Expanded: 2,
	},
	CodeActionKind: {
		QuickFix: "quickfix",
	},
}))

vi.mock("fast-glob", () => ({
	default: {
		async: vi.fn(),
		convertPathToPattern: vi.fn((path: string) => path),
	},
}))

vi.mock("./configuration.js", () => ({
	CONFIGURATION: {
		COMMANDS: {
			OPEN_EDITOR_VIEW: {
				command: "sherlock.openEditorView",
				createCallback: createOpenEditorViewCallback,
				register: vi.fn(() => ({ dispose: vi.fn() })),
			},
			RELOAD: {
				command: "sherlock.reloadProject",
				callback: vi.fn(),
				register: vi.fn(() => ({ dispose: vi.fn() })),
			},
		},
		FILES: {
			PROJECT: "project.inlang/settings.json",
		},
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_CREATE_MESSAGE: { fire: vi.fn() },
			ON_DID_EXTRACT_MESSAGE: { fire: vi.fn() },
			ON_DID_PROJECT_CHANGE: {
				fire: vi.fn(),
				event: vi.fn(() => ({ dispose: vi.fn() })),
			},
			ON_DID_PROJECT_TREE_VIEW_CHANGE: { fire: vi.fn() },
			ON_DID_ERROR_TREE_VIEW_CHANGE: { fire: vi.fn() },
		},
	},
}))

vi.mock("./utilities/utils.js", () => ({
	handleError: vi.fn(),
}))

vi.mock("./utilities/project/project.js", () => ({
	projectView: vi.fn(),
}))

vi.mock("./decorations/messagePreview.js", () => ({
	messagePreview: vi.fn(),
}))

vi.mock("./actions/extractMessage.js", () => ({
	ExtractMessage: class {
		static providedCodeActionKinds = []
	},
}))

vi.mock("./utilities/errors/errors.js", () => ({
	errorView: vi.fn(),
}))

vi.mock("./utilities/messages/messages.js", () => ({
	messageView: vi.fn(),
}))

vi.mock("./utilities/fs/createFileSystemMapper.js", () => ({
	createFileSystemMapper: vi.fn(() => environment.mappedFs),
}))

vi.mock("./utilities/project/projectSessionEnvironment.js", () => ({
	createProjectSessionEnvironment: environment.create,
}))

vi.mock("./utilities/getting-started/gettingStarted.js", () => ({
	gettingStartedView: vi.fn(),
}))

vi.mock("./utilities/project/closestInlangProject.js", () => ({
	closestInlangProject: vi.fn(),
}))

vi.mock("./utilities/recommendation/recommendation.js", () => ({
	recommendationBannerView: vi.fn(),
}))

vi.mock("./services/telemetry/index.js", () => ({
	capture: vi.fn(),
	initTelemetry: vi.fn(),
	telemetry: {
		capture: vi.fn(),
	},
}))

vi.mock("./utilities/settings/statusBar.js", () => ({
	statusBar: vi.fn(),
}))

vi.mock("./diagnostics/linterDiagnostics.js", () => ({
	linterDiagnostics: vi.fn(),
}))

vi.mock("./utilities/project/projectResourceSynchronization.js", () => ({
	saveProjectResources: vi.fn(async () => undefined),
}))

describe("discoverProjectsInWorkspace", () => {
	const workspaceFolder = {
		uri: {
			fsPath: "/workspace",
		},
	} as vscode.WorkspaceFolder

	beforeEach(async () => {
		await deactivate()
		vi.clearAllMocks()
		environment.runtime = {
			replaceProject: vi.fn(async () => ({ status: "committed" as const })),
			activeProject: vi.fn(() => undefined),
			lastRequestedProjectPath: vi.fn(() => undefined),
			dispose: vi.fn(async () => undefined),
		}
		environment.create.mockReturnValue(environment.runtime)
		;(
			vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }
		).workspaceFolders = [workspaceFolder]
	})

	it("suppresses unreadable workspace directories during project discovery", async () => {
		vi.mocked(fg.async).mockResolvedValueOnce(["/workspace/project.inlang"])

		const projects = await discoverProjectsInWorkspace({ workspaceFolder })

		expect(fg.async).toHaveBeenCalledWith(
			"/workspace/**/*.inlang",
			expect.objectContaining({
				onlyDirectories: true,
				ignore: ["**/node_modules/**"],
				absolute: true,
				cwd: "/workspace",
				suppressErrors: true,
			})
		)
		expect(projects).toEqual([
			{
				projectPath: "/workspace/project.inlang",
			},
		])
	})

	it("initializes an empty project list if discovery still fails", async () => {
		const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		vi.mocked(fg.async).mockRejectedValueOnce(error)

		const projects = await discoverProjectsInWorkspace({ workspaceFolder })

		expect(handleError).toHaveBeenCalledWith(error)
		expect(projects).toEqual([])
	})

	it("falls back to Getting Started when activation discovery fails before state exists", async () => {
		const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		const context = {
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		vi.mocked(fg.async).mockRejectedValueOnce(error)

		await expect(activate(context)).resolves.toBeUndefined()

		expect(handleError).toHaveBeenCalledWith(error)
		expect(state().projectsInWorkspace).toEqual([])
		expect(gettingStartedView).toHaveBeenCalledWith(expect.objectContaining({ workspaceFolder }))
	})

	it("registers global views once while replacing only the project session", async () => {
		const messageController = { bindProject: vi.fn() }
		const context = {
			subscriptions: [],
			extensionUri: { fsPath: "/extension" },
		} as unknown as vscode.ExtensionContext
		vi.mocked(fg.async).mockResolvedValueOnce(["/workspace/project.inlang"])
		vi.mocked(closestInlangProject).mockResolvedValueOnce({
			projectPath: "/workspace/project.inlang",
		} as any)
		vi.mocked(messageView).mockResolvedValueOnce(messageController as any)

		await activate(context)
		await getProjectRuntime().replaceProject("/workspace/project.inlang")

		expect(createProjectSessionEnvironment).toHaveBeenCalledWith({
			fileSystem: environment.mappedFs,
			messageView: messageController,
		})
		expect(environment.runtime.replaceProject).toHaveBeenNthCalledWith(
			1,
			"/workspace/project.inlang"
		)
		expect(environment.runtime.replaceProject).toHaveBeenNthCalledWith(
			2,
			"/workspace/project.inlang"
		)
		expect(projectView).toHaveBeenCalledTimes(1)
		expect(messageView).toHaveBeenCalledTimes(1)
		expect(messageView).toHaveBeenCalledWith({
			workspaceFolder,
			extensionUri: context.extensionUri,
			subscriptions: context.subscriptions,
		})
		expect(createOpenEditorViewCallback).toHaveBeenCalledOnce()
		expect(createOpenEditorViewCallback).toHaveBeenCalledWith({
			extensionUri: context.extensionUri,
		})
		expect(errorView).toHaveBeenCalledTimes(1)
		expect(recommendationBannerView).toHaveBeenCalledTimes(1)

		await deactivate()
		await deactivate()
		expect(environment.runtime.dispose).toHaveBeenCalledTimes(1)
	})

	it("keeps global views and the runtime available after the initial project load fails", async () => {
		const loadError = new Error("plugin failed to load")
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		vi.mocked(fg.async).mockResolvedValueOnce(["/workspace/project.inlang"])
		vi.mocked(closestInlangProject).mockResolvedValueOnce({
			projectPath: "/workspace/project.inlang",
		} as any)
		environment.runtime.replaceProject
			.mockResolvedValueOnce({ status: "failed", error: loadError })
			.mockResolvedValueOnce({ status: "committed" })
		environment.runtime.lastRequestedProjectPath.mockReturnValue("/workspace/project.inlang")

		await activate(context)

		expect(handleError).toHaveBeenCalledWith(loadError)
		expect(projectView).toHaveBeenCalledTimes(1)
		expect(errorView).toHaveBeenCalledTimes(1)
		expect(getProjectRuntime().lastRequestedProjectPath()).toBe("/workspace/project.inlang")
		await expect(getProjectRuntime().replaceProject("/workspace/project.inlang")).resolves.toEqual({
			status: "committed",
		})
		expect(environment.runtime.replaceProject).toHaveBeenCalledTimes(2)
	})

	it("reports whether a leased project export was saved, inactive, or failed", async () => {
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: [] })) },
		}
		const completedLease = {
			path: "/workspace/project.inlang",
			project,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}

		await expect(saveProject(completedLease as any)).resolves.toBe("saved")
		expect(saveProjectResources).toHaveBeenCalledWith(project, "/workspace/project.inlang")
		await expect(
			saveProject({
				...completedLease,
				runTask: vi.fn(async () => ({ status: "inactive" as const })),
			} as any)
		).resolves.toBe("inactive")

		const saveError = new Error("disk full")
		vi.mocked(saveProjectResources).mockRejectedValueOnce(saveError)
		await expect(saveProject(completedLease as any)).resolves.toBe("failed")
		expect(handleError).toHaveBeenCalledWith(saveError)
	})
})
