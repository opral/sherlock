import * as vscode from "vscode"
import {
	loadProjectInMemory,
	newProject,
	saveProjectToDirectory,
	type ProjectSettings,
} from "@inlang/sdk"
import fs from "node:fs/promises"
import { createFileSystemMapper } from "../fs/createFileSystemMapper.js"
import path from "node:path"

/**
 * Plugins of a new project: messages in `messages/{locale}.json` (inlang message format) and
 * Paraglide JS's `m.key()` calls in code. Major-version URLs pick up fixes; message-format 4.5 keeps
 * the text of unchanged messages on save, and the m-function matcher 2.3 adds usage analysis.
 */
export const NEW_PROJECT_SETTINGS: ProjectSettings = {
	$schema: "https://inlang.com/schema/project-settings",
	baseLocale: "en",
	locales: ["en"],
	modules: [
		"https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js",
		"https://cdn.jsdelivr.net/npm/@inlang/plugin-m-function-matcher@2/dist/index.js",
	],
	"plugin.inlang.messageFormat": {
		pathPattern: "./messages/{locale}.json",
	},
}

/**
 * Creates a new project in the workspace folder.
 * @param args - The arguments for the command.
 * @param args.workspaceFolderPath - The path to the workspace folder.
 */
export async function createNewProjectHandler(args: { workspaceFolderPath: string }) {
	try {
		const workspaceFolderPath = args.workspaceFolderPath
		const mappedFs = createFileSystemMapper(path.normalize(workspaceFolderPath), fs)

		// The path to the project directory
		const projectPath = path.normalize(`${workspaceFolderPath}/project.inlang`)

		// Create a new project in memory
		const project = await loadProjectInMemory({
			blob: await newProject({ settings: NEW_PROJECT_SETTINGS }),
		})

		// Save the project blob as a directory
		await saveProjectToDirectory({
			fs: mappedFs,
			project,
			path: projectPath,
		})

		// Reload the window after creating and saving the project
		vscode.commands.executeCommand("workbench.action.reloadWindow")
	} catch (error: any) {
		vscode.window.showErrorMessage(`Failed to create new project: ${error.message}`)
	}
}
