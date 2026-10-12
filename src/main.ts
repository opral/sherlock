import * as vscode from "vscode"
import { handleError } from "./utilities/utils.js"
import { CONFIGURATION } from "./configuration.js"
import { projectView } from "./utilities/project/project.js"
import { captureProjectView } from "./utilities/project/projectViewTelemetry.js"
import { setProjectsInWorkspace, state } from "./utilities/state.js"
import { errorView } from "./utilities/errors/errors.js"
import { messageView, type MessageViewController } from "./utilities/messages/messages.js"
import { createFileSystemMapper, type FileSystem } from "./utilities/fs/createFileSystemMapper.js"
import fs from "node:fs/promises"
import { gettingStartedView } from "./utilities/getting-started/gettingStarted.js"
import { closestInlangProject } from "./utilities/project/closestInlangProject.js"
import { recommendationBannerView } from "./utilities/recommendation/recommendation.js"
import { capture, initTelemetry, removeLegacyUserId } from "./services/telemetry/index.js"
import packageJson from "../package.json" with { type: "json" }
import { statusBar } from "./utilities/settings/statusBar.js"
import fg from "fast-glob"
import type { InlangProject } from "@inlang/sdk"
import type { ActiveProjectLease } from "./utilities/project/projectRuntime.js"
import path from "node:path"
import {
	disposeProjectRuntime,
	getProjectRuntime,
	installProjectRuntime,
} from "./utilities/project/projectRuntime.js"
import { createProjectSessionEnvironment } from "./utilities/project/projectSessionEnvironment.js"
import { saveProjectResources } from "./utilities/project/projectResourceSynchronization.js"

// Entry Point
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const telemetryLogger = initTelemetry({
		extensionMode: context.extensionMode,
		version: packageJson.version,
	})
	if (telemetryLogger) context.subscriptions.push(telemetryLogger)
	void removeLegacyUserId()

	try {
		vscode.commands.executeCommand("setContext", "sherlock:hasProjectInWorkspace", false)
		vscode.commands.executeCommand("setContext", "sherlock:showRecommendationBanner", false)
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]

		if (!workspaceFolder) {
			console.warn("No workspace folder found.")
			return
		}

		const mappedFs = createFileSystemMapper(path.normalize(workspaceFolder.uri.fsPath), fs)

		await setProjects({ workspaceFolder })
		registerGlobalCommands(context)
		let messageController: MessageViewController | undefined
		if (state().projectsInWorkspace.length > 0) {
			messageController = await messageView({
				workspaceFolder,
				extensionUri: context.extensionUri,
				subscriptions: context.subscriptions,
			})
		}
		const runtime = createProjectSessionEnvironment({
			fileSystem: mappedFs,
			messageView: messageController,
		})
		installProjectRuntime(runtime)
		context.subscriptions.push({ dispose: () => void disposeProjectRuntime() })
		if (state().projectsInWorkspace.length > 0) {
			await registerGlobalViews({ context, workspaceFolder, fs: mappedFs })
		}
		await activateInitialProjectSession({ context, workspaceFolder, fs: mappedFs })

		capture({ event: "app:session_start" })
	} catch (error) {
		await disposeProjectRuntime()
		handleError(error)
	}
}

// Main Function
async function activateInitialProjectSession(args: {
	context: vscode.ExtensionContext
	workspaceFolder: vscode.WorkspaceFolder
	fs: FileSystem
}): Promise<void> {
	if (state().projectsInWorkspace.length > 0) {
		// find the closest project to the workspace
		const closestProjectToWorkspace = await closestInlangProject({
			workingDirectory: path.normalize(args.workspaceFolder.uri.fsPath),
			projects: state().projectsInWorkspace,
		})

		const selectedProjectPath =
			state().selectedProjectPath ||
			closestProjectToWorkspace?.projectPath ||
			state().projectsInWorkspace[0]?.projectPath ||
			""

		vscode.commands.executeCommand("setContext", "sherlock:hasProjectInWorkspace", true)
		const result = await getProjectRuntime().replaceProject(selectedProjectPath)
		if (result.status === "failed") handleError(result.error)
		// fire and forget: telemetry never delays or fails activation
		if (result.status === "committed") {
			void captureProjectView({ fs: args.fs, workspaceFolder: args.workspaceFolder })
		}

		return
	} else {
		await gettingStartedView(args)
	}
}

function registerGlobalCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		...Object.values(CONFIGURATION.COMMANDS).map((command) => {
			const callback =
				"createCallback" in command
					? command.createCallback({ extensionUri: context.extensionUri })
					: command.callback
			return command.register(command.command, callback as any)
		}),
		CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.event(() => {
			CONFIGURATION.EVENTS.ON_DID_PROJECT_TREE_VIEW_CHANGE.fire(undefined)
			CONFIGURATION.EVENTS.ON_DID_ERROR_TREE_VIEW_CHANGE.fire(undefined)
		})
	)
}

async function registerGlobalViews(args: {
	context: vscode.ExtensionContext
	workspaceFolder: vscode.WorkspaceFolder
	fs: FileSystem
}) {
	await recommendationBannerView(args)
	await projectView(args)
	await errorView(args)
	await statusBar(args)
}

export async function deactivate() {
	await disposeProjectRuntime()
}

export async function discoverProjectsInWorkspace(args: {
	workspaceFolder: vscode.WorkspaceFolder
}): Promise<Array<{ projectPath: string }>> {
	try {
		const workspacePath = fg.convertPathToPattern(args.workspaceFolder.uri.fsPath) // Normalize path
		return (
			await fg.async(`${workspacePath}/**/*.inlang`, {
				onlyDirectories: true,
				ignore: ["**/node_modules/**"],
				absolute: true, // Ensures paths are absolute and properly formatted
				cwd: workspacePath, // Makes it platform-agnostic
				suppressErrors: true,
			})
		).map((project) => ({
			projectPath: project,
		}))
	} catch (error) {
		handleError(error)
		return []
	}
}

async function setProjects(args: { workspaceFolder: vscode.WorkspaceFolder }) {
	setProjectsInWorkspace(await discoverProjectsInWorkspace(args))
}

export async function saveProject(
	lease:
		| ActiveProjectLease<InlangProject>
		| undefined = getProjectRuntime<InlangProject>().activeProject()
) {
	if (!lease) return "inactive" as const
	try {
		const result = await lease.runTask(() => saveProjectResources(lease.project, lease.path))
		return result.status === "completed" ? ("saved" as const) : ("inactive" as const)
	} catch (error) {
		handleError(error)
		return "failed" as const
	}
}
