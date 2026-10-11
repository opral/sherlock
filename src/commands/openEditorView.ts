import { commands, type Uri } from "vscode"
import { capture } from "../services/telemetry/index.js"
import { editorView } from "../utilities/editor/editorView.js"
import type { InlangProject } from "@inlang/sdk"
import { getProjectRuntime, type ActiveProjectLease } from "../utilities/project/projectRuntime.js"

/** The open editors by project and bundle id: a message has one editor, so edits never race. */
const openEditors = new Map<string, ReturnType<typeof editorView>>()

export function createOpenEditorViewCallback(args: {
	extensionUri: Uri
	activeProject?: () => ActiveProjectLease<InlangProject> | undefined
}) {
	const activeProject =
		args.activeProject ?? (() => getProjectRuntime<InlangProject>().activeProject())

	return async function (commandArgs: { bundleId: string }) {
		const lease = activeProject()

		if (!lease) return

		const key = `${lease.path}\u0000${commandArgs.bundleId}`
		const open = openEditors.get(key)
		if (open?.isDisposed?.() === false) {
			await open.createOrShowPanel()
			return
		}

		const editor = editorView({
			extensionUri: args.extensionUri,
			lease,
			initialBundleId: commandArgs.bundleId,
		})
		if (
			!lease.own({
				dispose: (reason) =>
					reason === "shutdown" ? editor.dispose({ persist: true }) : editor.dispose(),
			})
		) {
			await editor.dispose()
			return
		}
		openEditors.set(key, editor)
		await editor.createOrShowPanel()

		capture({ event: "editor:editor_open" })
		return undefined
	}
}

export const openEditorViewCommand = {
	command: "sherlock.openEditorView",
	title: "Sherlock: Open Editor View",
	register: commands.registerCommand,
	createCallback: createOpenEditorViewCallback,
}
