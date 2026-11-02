import * as vscode from "vscode"
import { CONFIGURATION } from "../../configuration.js"
import type { InlangProject } from "@inlang/sdk"
import { getProjectRuntime } from "../project/projectRuntime.js"
import { getProjectPatternErrors } from "./patternErrors.js"

export interface ErrorNode {
	label: string
	tooltip: string
	description?: string
	error: Error | undefined
}
export function createErrorNode(error: Error | 0 | undefined): ErrorNode {
	if (error) {
		return {
			label: error.name,
			tooltip: error.message,
			description: error.message,
			error: error,
		}
	} else if (error === 0) {
		return {
			label: "No errors found",
			tooltip: "All good!",
			error: undefined,
		}
	} else {
		return {
			label: "No project found in workspace",
			tooltip: "No project found in workspace. Please open a project to see errors.",
			error: new Error("No project found in workspace. Please open a project to see errors."),
		}
	}
}

export async function createErrorNodes(): Promise<ErrorNode[]> {
	const lease = getProjectRuntime<InlangProject>().activeProject()
	if (!lease) {
		// no project
		return [createErrorNode(undefined)]
	}
	const result = await lease.runTask(async () => {
		const [loadErrors, patternErrors] = await Promise.all([
			lease.project.errors.get(),
			getProjectPatternErrors(lease.project, lease.path),
		])
		return [...loadErrors, ...patternErrors]
	})
	if (result.status !== "completed") return [createErrorNode(undefined)]
	const errors = [...result.value]
	if (errors.length === 0) {
		// no errors
		return [createErrorNode(0)]
	}
	return errors.map(createErrorNode)
}

export function getTreeItem(element: ErrorNode): vscode.TreeItem {
	const treeItem = new vscode.TreeItem(
		element.label,
		element.error ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.None
	)
	treeItem.tooltip = element.tooltip
	treeItem.description = element.description
	treeItem.iconPath = element.error
		? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"))
		: new vscode.ThemeIcon("check", new vscode.ThemeColor("sideBar.foreground"))

	if (element.error) {
		treeItem.contextValue = "errorNode"
		treeItem.command = {
			command: "sherlock.copyError",
			title: "Copy Error",
			arguments: [element],
		}
	}

	return treeItem
}

export function createErrorTreeDataProvider(): vscode.TreeDataProvider<ErrorNode> {
	return {
		getTreeItem,
		getChildren: async () => await createErrorNodes(),
		onDidChangeTreeData: CONFIGURATION.EVENTS.ON_DID_ERROR_TREE_VIEW_CHANGE.event,
	}
}

export const errorView = async (args: { context: vscode.ExtensionContext }) => {
	const errorDataProvider = createErrorTreeDataProvider()

	args.context.subscriptions.push(
		vscode.window.registerTreeDataProvider("errorView", errorDataProvider),
		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.event(() =>
			CONFIGURATION.EVENTS.ON_DID_ERROR_TREE_VIEW_CHANGE.fire(undefined)
		)
	)

	return
}
