import * as vscode from "vscode"
import type { Disposable, WebviewPanel } from "vscode"

import { getUri } from "./helper/getUri.js"
import { getNonce } from "./helper/getNonce.js"
import { CONFIGURATION } from "../../configuration.js"
import { msg } from "../messages/msg.js"
import type { ChangeEventDetail } from "@inlang/editor-component"
import { deleteVariant } from "./helper/deleteVariant.js"
import { deleteBundleNested } from "./helper/deleteBundleNested.js"
import { applyChanges, handleUpdateBundle } from "./helper/handleBundleUpdate.js"
import { showCloudPanel } from "../cloud/cloudView.js"
import { createMessage } from "./helper/createMessage.js"
import { saveProject } from "../../main.js"
import { saveProjectResources } from "../project/projectResourceSynchronization.js"
import type { InlangProject } from "@inlang/sdk"
import type { ActiveProjectLease } from "../project/projectRuntime.js"
import { selectBundleById } from "../project/selectBundleById.js"

// Same interface as before
export interface UpdateBundleMessage {
	command: string
	change: ChangeEventDetail
	persist?: boolean
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
				if (e.webviewPanel.visible) await postData()
			},
			null,
			disposables
		)

		// Listen before the page loads: it asks for the data once it is ready ("ready")
		setWebviewMessageListener(panel.webview)
		panel.webview.html = getHtmlForWebview(panel.webview)
	}

	/** Sends the bundle as stored, and the settings, to the webview. */
	async function postData() {
		const data = await lease.runTask(async () => ({
			bundle: await selectBundleById(lease.project, bundleId),
			settings: await lease.project.settings.get(),
		}))
		if (data.status !== "completed") return
		await panel?.webview.postMessage({
			command: "change",
			data: data.value,
		})
	}

	/**
	 * The same message handler logic you used in your snippet,
	 * listening for 'updateBundle' etc.
	 */
	function setWebviewMessageListener(webview: vscode.Webview) {
		const disposable = webview.onDidReceiveMessage(async (message: any) => {
			const command = message.command

			switch (command) {
				case "ready":
					// the page loaded (messages posted before that are lost)
					await postData()
					return
				case "create-message":
					await queueMutation(() =>
						createMessage({ db: lease.project.db, message: message.message })
					)

					await updateView()
					return
				case "delete-variant":
					await queueMutation(() => deleteVariant({ db: lease.project.db, variantId: message.id }))

					await updateView()
					return
				case "delete-bundle": {
					const choice = await vscode.window.showWarningMessage(
						`Delete the message "${bundleId}" in every language?`,
						{
							modal: true,
							detail: "Its translations and forms are removed from the translation files.",
						},
						"Delete"
					)
					if (choice !== "Delete") return
					await queueMutation(() =>
						deleteBundleNested({ db: lease.project.db, bundleId: message.id })
					)

					await updateView()
					return
				}
				case "apply-changes":
					await queueMutation(async () => {
						try {
							await applyChanges(lease.project.db, message.changes)
						} catch (error) {
							console.error("Failed to apply the editor's changes", error)
							msg(`Couldn't save the edit. ${String(error)}`, "error")
							// show what is stored again
							message.persist = true
						}
					})
					if (message.persist === true) {
						await updateView()
					}
					return
				case "open-cloud":
					showCloudPanel({ source: "editor" })
					return
				case "change":
					await queueUpdate(message)

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
		})
		disposables.push(disposable)
	}

	function queueMutation(mutation: () => Promise<unknown>) {
		markDirty()
		const previousUpdate = pendingUpdate
		const execution = lease.runTask(async () => {
			await previousUpdate
			await mutation()
		})
		pendingUpdate = execution.then(() => undefined)
		return pendingUpdate
	}

	function queueUpdate(message: UpdateBundleMessage) {
		return queueMutation(() => handleUpdateBundle({ db: lease.project.db, message }))
	}

	function persistCurrentRevision() {
		const revision = editRevision
		const matchingUpdate = pendingUpdate
		const persistence = pendingPersistence.then(async () => {
			await matchingUpdate
			if (revision <= persistedRevision) return
			const result = await saveProject(lease)
			if (result === "saved") persistedRevision = Math.max(persistedRevision, revision)
		})
		pendingPersistence = persistence.catch(() => undefined)
		return persistence
	}

	/**
	 * Update view
	 */
	async function updateView() {
		await pendingUpdate
		if (!lease.isCurrent()) return

		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()

		const data = await lease.runTask(async () => ({
			bundle: await selectBundleById(lease.project, bundleId),
			settings: await lease.project.settings.get(),
		}))
		if (data.status !== "completed") return
		panel?.webview.postMessage({
			command: "change",
			data: data.value,
		})
		const deleted = data.value.bundle === undefined

		const workspaceFolder = vscode.workspace.workspaceFolders![0]
		if (workspaceFolder) {
			try {
				await persistCurrentRevision()
			} catch (error) {
				console.error("Failed to save project", error)
				msg(`Failed to save project. ${String(error)}`, "error")
			}
		}
		// the message was deleted: nothing left to edit
		if (deleted) panel?.dispose()
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
		await pendingUpdate
		await pendingPersistence
		if (options.persist && editRevision > persistedRevision) {
			const revision = editRevision
			await saveProjectResources(lease.project, lease.path)
			persistedRevision = Math.max(persistedRevision, revision)
		}
		const currentPanel = panel
		panel = undefined
		currentPanel?.dispose()
		while (disposables.length) {
			const disposable = disposables.pop()
			if (disposable) disposable.dispose()
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
	}
}
