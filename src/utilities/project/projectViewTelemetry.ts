import type * as vscode from "vscode"
import path from "node:path"
import * as Sherlock from "@inlang/recommend-sherlock"
import type { InlangProject } from "@inlang/sdk"
import { capture, isUsageEnabled } from "../../services/telemetry/index.js"
import type { FileSystem } from "../fs/createFileSystemMapper.js"
import { getProjectRuntime } from "./projectRuntime.js"
import { getProjectSize } from "./projectSize.js"

/**
 * Reports `project:project_view` for the project that was just loaded: its size (`message_count`,
 * `language_count`), the number of project errors and whether the workspace recommends Sherlock.
 * `project_id` (a salted hash) is added by `capture`.
 *
 * Call it once per load, after `replaceProject` committed: at activation and when the user
 * switches project. It is not called for edits, nor for the reloads that follow changes of the
 * message files on disk.
 *
 * Never throws and nothing waits for it: call it without `await`. Only counts and booleans are
 * sent, no message texts, keys, file names or paths (project errors can contain paths: only
 * their number is sent).
 */
export async function captureProjectView(args: {
	fs: FileSystem
	workspaceFolder: vscode.WorkspaceFolder
}): Promise<void> {
	try {
		// no queries, no file reads if the event is not going to be sent
		if (!isUsageEnabled()) return
		const lease = getProjectRuntime<InlangProject>().activeProject()
		if (!lease) return

		const measured = await lease.runTask(async () => ({
			...(await getProjectSize(lease.project)),
			errorCount: (await lease.project.errors.get()).length,
		}))
		if (measured.status !== "completed") return
		const inWorkspaceRecommendation = await Sherlock.shouldRecommend({
			fs: args.fs,
			workingDirectory: path.normalize(args.workspaceFolder.uri.fsPath),
		})

		// The user switched project while counting: that project reports itself. Checked in the
		// same tick as the `capture` call below, which reads the id of the active project.
		if (!lease.isCurrent()) return
		await capture({
			event: "project:project_view",
			properties: {
				message_count: measured.value.messageCount,
				language_count: measured.value.languageCount,
				error_count: measured.value.errorCount,
				in_workspace_recommendation: inWorkspaceRecommendation,
			},
		})
	} catch {
		// telemetry never gets in the user's way
	}
}
