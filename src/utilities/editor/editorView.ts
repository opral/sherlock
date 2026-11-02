import * as vscode from "vscode"
import type { Disposable, WebviewPanel } from "vscode"

import { getUri } from "./helper/getUri.js"
import { getNonce } from "./helper/getNonce.js"
import { CONFIGURATION } from "../../configuration.js"
import { msg } from "../messages/msg.js"
import type { ChangeEventDetail } from "@inlang/editor-component"
import { deleteVariant } from "./helper/deleteVariant.js"
import { deleteBundleNested } from "./helper/deleteBundleNested.js"
import { applyResourceChanges, handleUpdateBundle } from "./helper/handleBundleUpdate.js"
import { showCloudPanel } from "../cloud/cloudView.js"
import { createMessage } from "./helper/createMessage.js"
import { saveProject } from "../../main.js"
import { saveProjectResources } from "../project/projectResourceSynchronization.js"
import type { InlangProject } from "@inlang/sdk"
import type { ActiveProjectLease } from "../project/projectRuntime.js"
import { selectBundleById } from "../project/selectBundleById.js"
import { mutateBundle } from "./helper/mutateBundle.js"

// Same interface as before
export interface UpdateBundleMessage {
	command: string
	change: ChangeEventDetail
	persist?: boolean
	patternText?: string
}

/**
 * An ID you can use to differentiate panels in VS Code.
 * (Doesn't have to match the old 'editorView' if you don't want.)
 */
export const EDITOR_PANEL_ID = "editorViewPanel"

/**
 * Creates or reveals a regular WebviewPanel (like an editor tab),
 * instead of a side-view via WebviewViewProvider.
 *
 * All your bundle/update logic remains the same.
 */
export function editorView(args: {
	extensionUri: vscode.Uri
	lease: ActiveProjectLease<InlangProject>
	initialBundleId: string
}) {
	const { extensionUri, lease, initialBundleId } = args

	let panel: WebviewPanel | undefined
	let disposables: Disposable[] = []
	let bundleId = initialBundleId
	let pendingUpdate = Promise.resolve()
	let editRevision = 0
	let persistedRevision = 0
	let pendingPersistence = Promise.resolve()
	let disposed = false
	let webviewReady = false
	let viewRevision = 0
	const markDirty = () => {
		editRevision += 1
	}

	/**
	 * Opens a new panel if none is open, otherwise reveals the existing one.
	 */
	async function createOrShowPanel() {
		if (disposed) return
		if (panel) {
			// If we already have a panel, reveal it
			panel.reveal(vscode.ViewColumn.One)
			return
		}

		// Otherwise, create a brand-new panel
		panel = vscode.window.createWebviewPanel(
			EDITOR_PANEL_ID,
			`# ${bundleId}`,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
			}
		)

		// Set up disposal
		panel.onDidDispose(
			() => {
				if (lease.isCurrent()) void persistEdit()
				panel = undefined
				dispose()
			},
			null,
			disposables
		)

		// Listen to panel and load state when it's visible
		panel.onDidChangeViewState(
			async (e) => {
				if (e.webviewPanel.visible) await refreshView()
				else webviewReady = false
			},
			null,
			disposables
		)

		// The frontend announces readiness after installing its message listener.
		setWebviewMessageListener(panel.webview)
		panel.webview.html = getHtmlForWebview(panel.webview)
	}

	/**
	 * The same message handler logic you used in your snippet,
	 * listening for 'updateBundle' etc.
	 */
	function setWebviewMessageListener(webview: vscode.Webview) {
		const disposable = webview.onDidReceiveMessage(async (message: any) => {
			if (disposed || !message || typeof message !== "object") return
			const command = message.command

			try {
				switch (command) {
					case "ready":
						webviewReady = true
						await refreshView()
						return
					case "create-message":
						if (
							!(await queueMutation(() =>
								mutateBundle(lease.project, message.message.bundle_id, async (bundle) => {
									if (!bundle) return false
									await createMessage({ db: lease.project.db, message: message.message })
									return true
								})
							))
						)
							return

						await updateView()
						return
					case "delete-variant": {
						const targetBundleId = bundleId
						if (
							!(await queueMutation(() =>
								mutateBundle(lease.project, targetBundleId, async (bundle) => {
									if (
										!bundle?.messages.some((entry) =>
											entry.variants.some((variant) => variant.id === message.id)
										)
									)
										return false
									return await deleteVariant({ project: lease.project, variantId: message.id })
								})
							))
						)
							return

						await updateView()
						return
					}
					case "delete-bundle": {
						const targetBundleId = bundleId
						if (message.id !== targetBundleId) return
						const choice = await vscode.window.showWarningMessage(
							`Delete the message "${targetBundleId}" in every language?`,
							{
								modal: true,
								detail: "Its translations and forms are removed from the translation files.",
							},
							"Delete"
						)
						if (choice !== "Delete") return
						if (
							!(await queueMutation(() =>
								mutateBundle(lease.project, message.id, async (bundle) => {
									if (!bundle) return false
									await deleteBundleNested({ db: lease.project.db, bundleId: message.id })
									return true
								})
							))
						)
							return

						await updateView()
						return
					}
					case "apply-changes": {
						const targetBundleId = bundleId
						try {
							if (!Array.isArray(message.changes)) throw new Error("No editor changes provided")
							const changed = await queueMutation(() =>
								applyResourceChanges({
									project: lease.project,
									bundleId: targetBundleId,
									changes: message.changes,
									patternTexts: message.patternTexts,
									patternEdits: message.patternEdits,
								})
							)
							if (!changed) await refreshView({ reset: true })
							else if (message.persist === true) await updateView()
						} catch (error) {
							msg(`Couldn't save the edit. ${String(error)}`, "error")
							await refreshView({ reset: true })
						}
						return
					}
					case "open-cloud":
						showCloudPanel({ source: "editor" })
						return
					case "change":
						if (!(await queueUpdate(message))) return

						if (message.persist === true) {
							await updateView()
						}
						return
					case "persist-edit":
						await persistEdit()
						return
					case "show-info-message":
						msg(message.message, "info", "statusBar", vscode.StatusBarAlignment.Right, 3000)
						return
					case "show-error-message":
						msg(message.message, "error", "statusBar", vscode.StatusBarAlignment.Right, 3000)
						return

					default:
						console.error("Unknown command from webview:", command)
				}
			} catch (error) {
				console.error("Failed to handle editor message", error)
				msg(`Failed to update editor. ${String(error)}`, "error")
			}
		})
		disposables.push(disposable)
	}

	function queueMutation(mutation: () => Promise<unknown>) {
		viewRevision += 1
		const previousUpdate = pendingUpdate
		const execution = lease.runTask(async () => {
			await previousUpdate
			if ((await mutation()) === false) return false
			markDirty()
			return true
		})
		// Ordering and cleanup must survive a failed edit. The caller still receives
		// the original failure so the message boundary can report it once.
		pendingUpdate = execution.then(
			() => undefined,
			() => undefined
		)
		return execution.then((result) => result.status === "completed" && result.value)
	}

	function queueUpdate(message: UpdateBundleMessage) {
		return queueMutation(() => handleUpdateBundle({ project: lease.project, message }))
	}

	function persistCurrentRevision() {
		const matchingUpdate = pendingUpdate
		const persistence = pendingPersistence.then(async () => {
			await matchingUpdate
			// Revisions advance when mutations finish, so capture the completed
			// state immediately before saving, after the matching update settles.
			const revision = editRevision
			if (revision <= persistedRevision) return
			const result = await saveProject(lease)
			if (result === "saved") persistedRevision = Math.max(persistedRevision, revision)
		})
		pendingPersistence = persistence.catch(() => undefined)
		return persistence
	}

	async function refreshView(options: { reset?: boolean } = {}) {
		const targetPanel = panel
		if (!targetPanel || disposed || !webviewReady) return
		const request = ++viewRevision
		const revision = editRevision
		const requestedBundleId = bundleId
		await pendingUpdate
		if (disposed || !lease.isCurrent() || request !== viewRevision) return
		const data = await lease.runTask(async () => ({
			bundle: await selectBundleById(lease.project, requestedBundleId),
			settings: await lease.project.settings.get(),
		}))
		if (
			data.status !== "completed" ||
			disposed ||
			panel !== targetPanel ||
			!webviewReady ||
			request !== viewRevision ||
			revision !== editRevision ||
			requestedBundleId !== bundleId
		)
			return
		await targetPanel.webview.postMessage({
			command: "change",
			data: data.value,
			...(options.reset ? { reset: true } : {}),
		})
		return data.value
	}

	/**
	 * Update view
	 */
	async function updateView() {
		await pendingUpdate
		if (!lease.isCurrent()) return

		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()

		const data = await refreshView()

		const workspaceFolder = vscode.workspace.workspaceFolders![0]
		if (workspaceFolder) {
			try {
				await persistCurrentRevision()
			} catch (error) {
				console.error("Failed to save project", error)
				msg(`Failed to save project. ${String(error)}`, "error")
			}
		}
		if (data && !data.bundle) panel?.dispose()
	}

	async function persistEdit() {
		await pendingUpdate
		if (!lease.isCurrent() || editRevision <= persistedRevision) return

		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()

		const workspaceFolder = vscode.workspace.workspaceFolders![0]
		if (workspaceFolder) {
			try {
				await persistCurrentRevision()
			} catch (error) {
				console.error("Failed to save project", error)
				msg(`Failed to save project. ${String(error)}`, "error")
			}
		}
	}

	/**
	 * Your original logic for generating the HTML,
	 * including dev vs. prod, React Refresh, etc.
	 */
	function getHtmlForWebview(webview: vscode.Webview) {
		const stylesUri = getUri(webview, extensionUri, [
			"assets",
			"sherlock-editor-app",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, extensionUri, [
			"assets",
			"sherlock-editor-app",
			"assets",
			"index.js",
		])

		const nonce = getNonce()

		const csp = [
			`default-src 'none';`,

			// Allow scripts from safe sources
			`script-src 'self' https://* 'nonce-${nonce}';`,

			// Allow inline styles for better compatibility
			`style-src ${webview.cspSource} 'self' 'unsafe-inline' https://*;`,

			// Allow fonts from safe sources
			`font-src ${webview.cspSource} https://*;`,

			// Allow images from trusted sources and `data:` URLs
			`img-src ${webview.cspSource} https://* data:;`,

			// Allow media from safe sources (if needed)
			`media-src ${webview.cspSource} https://* data:;`,

			// Allow connections to APIs, WebSockets, and data URIs - include http://localhost:3000 for RPC
			`connect-src https://* http://localhost:3000 data:;`,

			// Allow iframes only from trusted sources
			`frame-src 'self' https://*;`,
		].join(" ")

		return /*html*/ `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" type="text/css" href="${stylesUri}">
        <title>${bundleId}</title>
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
      </body>
    </html>`
	}

	/**
	 * Let external code update the bundleId if desired
	 */
	function setBundleId(newBundleId: string) {
		bundleId = newBundleId
		viewRevision += 1
	}

	function getBundleId() {
		return bundleId
	}

	/**
	 * Dispose any event listeners or watchers
	 */
	async function dispose(options: { persist?: boolean } = {}) {
		if (disposed) return
		disposed = true
		try {
			await pendingUpdate
			await pendingPersistence
			if (options.persist && editRevision > persistedRevision) {
				const revision = editRevision
				await saveProjectResources(lease.project, lease.path)
				persistedRevision = Math.max(persistedRevision, revision)
			}
		} finally {
			const currentPanel = panel
			panel = undefined
			currentPanel?.dispose()
			while (disposables.length) {
				const disposable = disposables.pop()
				if (disposable) disposable.dispose()
			}
		}
	}

	/**
	 * Return an object with methods to show the panel,
	 * set the bundleId, etc.
	 */
	return {
		createOrShowPanel,
		setBundleId,
		getBundleId,
		dispose,
		isDisposed: () => disposed,
	}
}
