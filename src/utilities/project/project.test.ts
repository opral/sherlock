import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import { state } from "../state.js"
import { CONFIGURATION } from "../../configuration.js"
import { capture } from "../../services/telemetry/index.js"
import {
	createProjectViewNodes,
	getTreeItem,
	handleTreeSelection,
	createTreeDataProvider,
	type ProjectViewNode,
	projectView,
} from "./project.js"
import { getProjectRuntime } from "./projectRuntime.js"
import type { FileSystem } from "../fs/createFileSystemMapper.js"

vi.mock("vscode", () => ({
	Uri: {
		parse: vi.fn((path: string) => ({ fsPath: path })),
	},
	window: {
		registerTreeDataProvider: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	ThemeIcon: class {},
	ThemeColor: class {},
	CancellationTokenSource: class {
		token = {}
	},
	TreeItemCollapsibleState: {
		Collapsed: 0,
		None: 1,
		Expanded: 2,
	},
	EventEmitter: vi.fn(),
}))

const replaceProject = vi.hoisted(() => vi.fn())

vi.mock("./projectRuntime.js", () => ({
	getProjectRuntime: vi.fn(() => ({
		replaceProject,
		activeProject: () => {
			const project = state().project
			return project
				? {
						project,
						runTask: async <T>(task: () => Promise<T>) => ({
							status: "completed" as const,
							value: await task(),
						}),
					}
				: undefined
		},
	})),
}))

vi.mock("../state.js", () => ({
	state: vi.fn(() => ({
		projectsInWorkspace: [
			{
				label: "to/project1",
				path: "/path/to/project1",
				isSelected: false,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			},
			{
				label: "to/project2",
				path: "/path/to/project2",
				isSelected: true,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			},
		],
		selectedProjectPath: "",
	})),
}))

vi.mock("../../configuration.js", () => ({
	CONFIGURATION: {
		STRINGS: {
			APP_ID: "test-app-id",
		},
		EVENTS: {
			ON_DID_EDIT_MESSAGE: {
				fire: vi.fn(),
			},
			ON_DID_CREATE_MESSAGE: {
				fire: vi.fn(),
			},
			ON_DID_EXTRACT_MESSAGE: {
				fire: vi.fn(),
			},
			ON_DID_PROJECT_TREE_VIEW_CHANGE: {
				fire: vi.fn(),
				event: new vscode.EventEmitter(),
			},
			ON_DID_ERROR_TREE_VIEW_CHANGE: {
				fire: vi.fn(),
			},
		},
	},
}))

vi.mock("../../services/telemetry/index.js", () => ({
	capture: vi.fn(),
}))

vi.mock("@lix-js/client", () => ({
	openRepository: vi.fn(),
	findRepoRoot: vi.fn(),
}))

describe("createProjectViewNodes", () => {
	const mockContext = {} as vscode.ExtensionContext
	const mockWorkspaceFolder = {
		uri: {
			fsPath: "/path/to/workspace",
		},
	} as vscode.WorkspaceFolder

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should create project view nodes from state", () => {
		// @ts-expect-error
		state.mockReturnValue({
			projectsInWorkspace: [
				{
					projectPath: "/path/to/project1",
				},
				{
					projectPath: "/path/to/project2",
				},
			],
			selectedProjectPath: "/path/to/project2",
		})

		const nodes = createProjectViewNodes({
			context: mockContext,
			workspaceFolder: mockWorkspaceFolder,
		})
		expect(nodes.length).toBe(2)
		expect(nodes[0]?.label).toBe("project1")
		expect(nodes[1]?.isSelected).toBe(true)
	})

	it("should return empty array if projectsInWorkspace is undefined", () => {
		// @ts-expect-error
		state.mockReturnValue({
			projectsInWorkspace: [],
			selectedProjectPath: "/path/to/project2",
		})
		const nodes = createProjectViewNodes({
			context: mockContext,
			workspaceFolder: mockWorkspaceFolder,
		})
		expect(nodes).toEqual([])
	})

	it("should handle undefined projectPath", () => {
		// @ts-expect-error
		state.mockReturnValue({
			projectsInWorkspace: [
				{
					projectPath: undefined,
				},
			],
			selectedProjectPath: "/path/to/project2",
		})
		const nodes = createProjectViewNodes({
			context: mockContext,
			workspaceFolder: mockWorkspaceFolder,
		})
		expect(nodes.some((node) => node.label === "")).toBe(true)
	})
})

describe("getTreeItem", () => {
	const mockContext = {} as vscode.ExtensionContext

	it("should return a TreeItem for a given ProjectViewNode", () => {
		const node: ProjectViewNode = {
			label: "testProject",
			path: "/path/to/testproject",
			relativePath: "./path/to/testproject.inlang",
			isSelected: true,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			context: mockContext,
		}
		const workspaceFolder = {
			uri: {
				fsPath: "/path/to/workspace",
			},
		} as vscode.WorkspaceFolder
		const treeItem = getTreeItem({
			element: node,
			fs: {} as FileSystem,
			workspaceFolder,
		})
		expect(treeItem.label).toBe("testProject")
		expect(treeItem.description).toBe("./path/to/testproject.inlang")
		expect(treeItem.tooltip).toBe("/path/to/testproject")
		expect(treeItem.iconPath).toBeInstanceOf(vscode.ThemeIcon)
	})
})

describe("handleTreeSelection", () => {
	const mockContext = {} as vscode.ExtensionContext

	beforeEach(() => {
		replaceProject.mockReset().mockResolvedValue({ status: "committed" })
	})

	it("should replace the session when the user selects a project", async () => {
		const selectedNode: ProjectViewNode = {
			label: "SelectedProject",
			path: "/path/to/selected",
			relativePath: "./path/to/selected",
			isSelected: true,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			context: mockContext,
		}
		const workspaceFolder = {
			uri: {
				fsPath: "/path/to/workspace",
			},
		} as vscode.WorkspaceFolder

		const errors: Error[] = []

		const mockProject = {
			errors: {
				get: vi.fn().mockReturnValue(errors),
			},
		}

		vi.mocked(state).mockReturnValue({
			projectsInWorkspace: [],
			selectedProjectPath: selectedNode.path,
			project: mockProject,
		} as any)

		await handleTreeSelection({ selectedNode, fs, workspaceFolder })

		expect(getProjectRuntime().replaceProject).toHaveBeenCalledWith(selectedNode.path)
		expect(capture).toBeCalledWith(
			expect.objectContaining({
				event: "project:project_load",
				properties: expect.objectContaining({
					// a count, never the errors (they can contain paths)
					error_count: errors.length,
				}),
			})
		)
	})

	it("should show error message if project loading fails", async () => {
		const selectedNode: ProjectViewNode = {
			label: "SelectedProject",
			path: "/path/to/selected",
			relativePath: "./path/to/selected",
			isSelected: true,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			context: mockContext,
		}
		const workspaceFolder = {
			uri: {
				fsPath: "/path/to/workspace",
			},
		} as vscode.WorkspaceFolder

		replaceProject.mockRejectedValueOnce(new Error("Loading failed"))

		await handleTreeSelection({ selectedNode, fs, workspaceFolder })

		expect(vscode.window.showErrorMessage).toBeCalledWith(
			expect.stringContaining("Failed to load project")
		)
	})

	it("should show error message if project loading fails", async () => {
		const selectedNode: ProjectViewNode = {
			label: "SelectedProject",
			path: "/path/to/selected",
			relativePath: "./path/to/selected",
			isSelected: true,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			context: {} as vscode.ExtensionContext,
		}

		const error = new Error("Loading failed")

		replaceProject.mockRejectedValueOnce(error)

		const mockWorkspaceFolder = {
			uri: { fsPath: "/path/to/workspace" },
		} as vscode.WorkspaceFolder

		await handleTreeSelection({
			selectedNode,
			fs,
			workspaceFolder: mockWorkspaceFolder,
		})

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			`Failed to load project "/path/to/selected": Error: ${error.message}`
		)
	})
})

describe("createTreeDataProvider", () => {
	const mockContext = {} as vscode.ExtensionContext

	it("should create a TreeDataProvider", () => {
		const workspaceFolder = {
			uri: {
				fsPath: "/path/to/workspace",
			},
		} as vscode.WorkspaceFolder
		const treeDataProvider = createTreeDataProvider({
			fs,
			workspaceFolder,
			context: mockContext,
		})
		expect(treeDataProvider).toBeDefined()
		expect(treeDataProvider.getTreeItem).toBeInstanceOf(Function)
		expect(treeDataProvider.getChildren).toBeInstanceOf(Function)
	})
})

describe("projectView", () => {
	it("should set up the project view", async () => {
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		const workspaceFolder = {
			uri: {
				fsPath: "/path/to/workspace",
			},
		} as vscode.WorkspaceFolder

		await projectView({ context, workspaceFolder, fs })

		expect(vscode.window.registerTreeDataProvider).toBeCalled()
	})
})
