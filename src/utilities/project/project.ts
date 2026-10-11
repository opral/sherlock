import * as vscode from "vscode"
import { CONFIGURATION } from "../../configuration.js"
import { capture } from "../../services/telemetry/index.js"
import { state } from "../state.js"
import * as Sherlock from "@inlang/recommend-sherlock"
import type { FileSystem } from "../fs/createFileSystemMapper.js"
import path from "node:path"
import { getProjectRuntime } from "./projectRuntime.js"
import type { InlangProject } from "@inlang/sdk"

let projectViewNodes: ProjectViewNode[] = []

export interface ProjectViewNode {
	label: string
	path: string
	relativePath: string
	isSelected: boolean
	collapsibleState: vscode.TreeItemCollapsibleState
	context: vscode.ExtensionContext
}

export function createProjectViewNodes(args: {
	context: vscode.ExtensionContext
	workspaceFolder: vscode.WorkspaceFolder
}): ProjectViewNode[] {
	const projectsInWorkspace = state().projectsInWorkspace

	if (!projectsInWorkspace) {
		console.error("state().projectsInWorkspace is undefined")
		return []
	}

	projectViewNodes = projectsInWorkspace.map((project) => {
		// Ensure projectPath is a string
		if (!project.projectPath) {
			return {
				label: "",
				path: "",
				isSelected: false,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				context: args.context,
			} as ProjectViewNode
		}

		const projectPath = typeof project.projectPath === "string" ? project.projectPath : ""

		// Ensure forward slashes are used across platforms
		const normalizedProjectPath = projectPath.split(path.sep).join("/")

		// Extract project name safely
		const projectName = normalizedProjectPath.split("/").slice(-1).join("/").replace(".inlang", "")

		// Compute relative path
		const relativePath = path
			.relative(args.workspaceFolder.uri.fsPath, projectPath) // Get relative path
			.split(path.sep) // Normalize separators
			.join("/") // Ensure forward slashes for cross-platform compatibility

		const finalRelativePath = `./${relativePath}`

		return {
			label: projectName,
			path: project.projectPath,
			relativePath: finalRelativePath,
			isSelected: project.projectPath === state().selectedProjectPath,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			context: args.context,
		} as ProjectViewNode
	})

	return projectViewNodes
}

export function getTreeItem(args: {
	element: ProjectViewNode
	fs: FileSystem
	workspaceFolder: vscode.WorkspaceFolder
}): vscode.TreeItem {
	return {
		label: args.element.label,
		tooltip: args.element.path,
		description: args.element.relativePath,
		iconPath: args.element.isSelected
			? new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("sideBar.foreground"))
			: new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("sideBar.foreground")),
		contextValue: args.element.isSelected ? "projectViewNodeSelected" : "projectViewNode",
		command: {
			command: "sherlock.openProject",
			title: "Open File",
			arguments: [args.element, args.fs, args.workspaceFolder],
		},
	}
}

export async function handleTreeSelection(args: {
	selectedNode: ProjectViewNode
	fs: FileSystem
	workspaceFolder: vscode.WorkspaceFolder
}): Promise<void> {
	const selectedProject = path.normalize(args.selectedNode.path)

	try {
		const result = await getProjectRuntime<InlangProject>().replaceProject(selectedProject)
		if (result.status === "failed") throw result.error
		if (result.status !== "committed") return
		projectViewNodes = projectViewNodes.map((node) => ({
			...node,
			isSelected: node.path === args.selectedNode.path,
		}))

		const isInWorkspaceRecommendation = await Sherlock.shouldRecommend({
			fs: args.fs,
			workingDirectory: path.normalize(args.workspaceFolder.uri.fsPath),
		})

		const activeProject = getProjectRuntime<InlangProject>().activeProject()
		const projectErrors = activeProject
			? await activeProject.runTask(() => activeProject.project.errors.get())
			: undefined
		capture({
			event: "project:project_load",
			properties: {
				// a count only: errors can contain paths
				error_count: projectErrors?.status === "completed" ? projectErrors.value.length : 0,
				in_workspace_recommendation: isInWorkspaceRecommendation,
			},
		})
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to load project "${selectedProject}": ${error}`)
	}
}

export function createTreeDataProvider(args: {
	fs: FileSystem
	workspaceFolder: vscode.WorkspaceFolder
	context: vscode.ExtensionContext
}): vscode.TreeDataProvider<ProjectViewNode> {
	return {
		getTreeItem: (element: ProjectViewNode) =>
			getTreeItem({
				element,
				fs: args.fs,
				workspaceFolder: args.workspaceFolder,
			}),
		getChildren: () =>
			createProjectViewNodes({
				context: args.context,
				workspaceFolder: args.workspaceFolder,
			}),
		onDidChangeTreeData: CONFIGURATION.EVENTS.ON_DID_PROJECT_TREE_VIEW_CHANGE.event,
	}
}

export const projectView = async (args: {
	context: vscode.ExtensionContext
	workspaceFolder: vscode.WorkspaceFolder
	fs: FileSystem
}) => {
	const treeDataProvider = createTreeDataProvider({
		fs: args.fs,
		workspaceFolder: args.workspaceFolder,
		context: args.context,
	})

	treeDataProvider.getChildren()

	args.context.subscriptions.push(
		vscode.window.registerTreeDataProvider("projectView", treeDataProvider)
	)
}
