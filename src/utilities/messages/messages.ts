import * as vscode from "vscode"
import { isEqual } from "lodash-es"
import * as stateModule from "../state.js"
import { CONFIGURATION } from "../../configuration.js"
import { getStringFromPattern } from "./query.js"
import { escapeHtml } from "../utils.js"
import { throttle } from "throttle-debounce"
import {
	selectBundleNested,
	type BundleNested,
	type IdeExtensionConfig,
	type InlangProject,
} from "@inlang/sdk"
import { logger } from "../logger.js"
import { pollQuery } from "../polling/pollQuery.js"
import type { Disposable, ProjectSession } from "../project/projectSession.js"

type MessageProjectSession = ProjectSession<InlangProject>

export type MessageViewController = vscode.WebviewViewProvider & {
	bindProject(session: MessageProjectSession): Disposable
}

const getSafeState =
	"safeState" in stateModule && typeof (stateModule as any).safeState === "function"
		? ((stateModule as any).safeState as typeof stateModule.state)
		: stateModule.state

export function createMessageWebviewProvider(args: {
	workspaceFolder: vscode.WorkspaceFolder
	extensionUri: vscode.Uri
	subscriptions: vscode.Disposable[]
}): MessageViewController {
	let bundles: BundleNested[] | undefined
	let isLoading = true
	let subscription: { unsubscribe: () => Promise<void> } | undefined
	let subscribedSession: MessageProjectSession | undefined
	let subscriptionTransition = Promise.resolve()
	let previousBundles: BundleNested[] | undefined
	let boundSession: MessageProjectSession | undefined
	let activeFileContent: string | undefined
	let lastDocumentUri: string | undefined
	let debounceTimer: NodeJS.Timeout | undefined
	let webviewView: vscode.WebviewView | undefined
	// Add a flag to prevent event loops
	let isProcessingUpdate = false
	let renderRevision = 0

	/**
	 * Connects the message view to a polling loop for the selected project.
	 *
	 * @param args.project - Active inlang project whose bundles should be streamed.
	 * @param args.projectPath - Absolute path of the project; used to avoid redundant subscriptions.
	 * @param args.force - Recreate the polling subscription even if one is already active.
	 *
	 * @example
	 * await subscribeToProjectBundles({
	 *   project,
	 *   projectPath: projectRoot,
	 * })
	 */
	const queueSubscriptionTransition = <T>(transition: () => Promise<T>) => {
		const result = subscriptionTransition.then(transition)
		subscriptionTransition = result.then(
			() => undefined,
			() => undefined
		)
		return result
	}

	const subscribeToProjectBundles = (args: { session: MessageProjectSession; force?: boolean }) =>
		queueSubscriptionTransition(async () => {
			if (boundSession !== args.session || !webviewView) return
			const shouldReuseExistingSubscription =
				!args.force && subscription && subscribedSession === args.session

			if (shouldReuseExistingSubscription) return

			const previousSubscription = subscription
			subscription = undefined
			subscribedSession = undefined
			await previousSubscription?.unsubscribe()

			if (boundSession !== args.session || !webviewView) return

			bundles = undefined
			previousBundles = undefined
			isLoading = true
			void updateWebviewContent()

			const poller = pollQuery(async () => {
				const result = await args.session.runTask(async () => {
					const query = selectBundleNested(args.session.project.db)
					return (await query.execute()) as BundleNested[]
				})
				return result.status === "completed" ? result.value : []
			})

			subscribedSession = args.session
			subscription = poller.subscribe((result) => {
				if (boundSession !== args.session || subscribedSession !== args.session) return
				const nextBundles = result as BundleNested[]
				if (!isEqual(previousBundles, nextBundles)) {
					logger.debug("Bundles updated via polling", {
						count: nextBundles.length,
					})
					previousBundles = [...nextBundles]
					bundles = nextBundles
					isLoading = false
					throttledUpdateWebviewContent()
				}
			})
		})

	const updateMessages = async () => {
		logger.debug("Message view update requested")
		const session = boundSession
		if (!session || !webviewView) {
			logger.warn("Skipping message update because no project is loaded")
			isLoading = true
			bundles = undefined
			updateWebviewContent()
			return
		}

		// A preceding view disposal may still be queued. Check subscription reuse
		// inside the same transition queue so reopening cannot reuse a departing view.
		await subscribeToProjectBundles({ session })
		if (boundSession === session && bundles !== undefined) throttledUpdateWebviewContent()
	}

	// Forcefully refresh message data
	const forceMessageRefresh = async () => {
		// Prevent recursive calls
		if (isProcessingUpdate) {
			logger.debug("Already processing an update, skipping")
			return
		}

		isProcessingUpdate = true
		logger.debug("Forcing immediate message refresh")
		const session = boundSession
		if (!session) {
			logger.warn("Cannot force refresh when no project is loaded")
			isProcessingUpdate = false
			return
		}

		try {
			logger.debug("Forced refresh requested via polling")
			await subscribeToProjectBundles({
				session,
				force: true,
			})
		} catch (error) {
			logger.error("Error during forced message refresh", error)
		} finally {
			// Allow future updates again
			setTimeout(() => {
				isProcessingUpdate = false
			}, 200)
		}
	}

	const debounceUpdate = () => {
		const activeEditor = vscode.window.activeTextEditor
		const fileContent = activeEditor ? activeEditor.document.getText() : ""
		const documentUri = activeEditor?.document.uri.toString()
		if (debounceTimer) {
			clearTimeout(debounceTimer)
		}
		debounceTimer = setTimeout(() => {
			if (activeFileContent !== fileContent) {
				if (documentUri && documentUri === lastDocumentUri) {
					logger.debug("File content changed in editor, updating view")
				}
				activeFileContent = fileContent
				lastDocumentUri = documentUri

				// First update the webview content to reflect current file
				updateWebviewContent()

				// Then trigger a data refresh to ensure latest translations are shown
				// This is important when editing translation files directly
				updateMessages()
			}
		}, 300)
	}

	const updateWebviewContent = async () => {
		const activeEditor = vscode.window.activeTextEditor
		const fileContent = activeEditor ? activeEditor.document.getText() : ""
		const session = boundSession
		if (!session || !webviewView) {
			logger.warn("Cannot update webview because project is undefined")
			bundles = undefined
			isLoading = true
			return
		}

		const view = webviewView
		const revision = ++renderRevision
		const currentBundles = bundles
		const loading = isLoading
		try {
			const rendered = await session.runTask(async () => {
				if (loading) return createMessagesLoadingHtml()
				const activeProject = session.project
				const ideExtension = (await activeProject.plugins.get()).find(
					(plugin) => plugin?.meta?.["app.inlang.ideExtension"]
				)?.meta?.["app.inlang.ideExtension"] as IdeExtensionConfig | undefined
				const messageReferenceMatchers = ideExtension?.messageReferenceMatchers
				const settings = await activeProject.settings.get()

				const matchedBundles = (
					await Promise.all(
						(messageReferenceMatchers ?? []).map(async (matcher) => {
							return matcher({ documentText: fileContent })
						})
					)
				).flat()

				// The poll already provides a complete snapshot. Avoid one SQL query per reference.
				const byId = new Map((currentBundles ?? []).map((bundle) => [bundle.id, bundle]))
				const referencedIds = new Set(
					matchedBundles.map((reference) => {
						// @ts-ignore Legacy matchers can still return messageId.
						reference.bundleId = reference.bundleId || reference.messageId
						return reference.bundleId
					})
				)
				const highlightedBundles = [...referencedIds]
					.map((id) => byId.get(id))
					.filter((bundle): bundle is BundleNested => bundle !== undefined)

				const highlightedMessagesHtml =
					highlightedBundles.length > 0
						? `<div class="highlighted-section">
                        <div class="banner"><span class="active-dot"></span><span>Current file<span></div>
                        ${await Promise.all(
													highlightedBundles.map(
														async (bundle) =>
															await createMessageHtml({
																bundle,
																position: matchedBundles.find((m) => m.bundleId === bundle?.id)
																	?.position,
																isHighlighted: true,
																workspaceFolder: args.workspaceFolder,
																project: activeProject,
																locales: settings.locales,
																lazy: true,
																projectPath: session.path,
															})
													)
												).then((htmls) => htmls.join(""))}
                    </div>`
						: ""

				const allMessagesBanner = '<div class="banner">All Messages</div>'
				let mainContentHtml = ""
				if (currentBundles && currentBundles.length > 0) {
					mainContentHtml = `${highlightedMessagesHtml}<main>${allMessagesBanner}${await Promise.all(
						currentBundles.map(
							async (message) =>
								await createMessageHtml({
									bundle: message,
									isHighlighted: false,
									workspaceFolder: args.workspaceFolder,
									project: activeProject,
									locales: settings.locales,
									lazy: true,
									projectPath: session.path,
								})
						)
					).then((htmls) => htmls.join(""))}</main>`
				} else {
					mainContentHtml = `${highlightedMessagesHtml}<main>${
						allMessagesBanner + createNoMessagesFoundHtml()
					}</main>`
				}

				return mainContentHtml
			})

			if (
				rendered.status === "completed" &&
				boundSession === session &&
				webviewView === view &&
				revision === renderRevision
			) {
				view.webview.html = getHtml({
					mainContent: rendered.value,
					renderRevision: revision,
					webview: view.webview,
					extensionUri: args.extensionUri,
				})
			}
		} catch (error) {
			logger.error("Unable to render messages", error)
			if (boundSession === session && webviewView === view && revision === renderRevision) {
				view.webview.html = getHtml({
					mainContent:
						"<main><p>Unable to load messages.</p><button onclick=\"vscode.postMessage({command: 'retryMessages'})\">Retry</button></main>",
					renderRevision: revision,
					webview: view.webview,
					extensionUri: args.extensionUri,
				})
			}
		}
	}

	const expandMessage = async (
		view: vscode.WebviewView,
		message: { bundleId: string; revision: number }
	) => {
		const session = boundSession
		const revision = renderRevision
		if (!session || webviewView !== view || message.revision !== revision) return
		const bundle = bundles?.find((item) => item.id === message.bundleId)
		if (!bundle) return
		try {
			const result = await session.runTask(async () =>
				getTranslationsTableHtml({
					bundle,
					workspaceFolder: args.workspaceFolder,
					project: session.project,
					locales: (await session.project.settings.get()).locales,
				})
			)
			if (
				result.status === "completed" &&
				boundSession === session &&
				webviewView === view &&
				renderRevision === revision
			) {
				await view.webview.postMessage({
					command: "messageDetails",
					bundleId: bundle.id,
					revision,
					html: result.value,
				})
			}
		} catch (error) {
			logger.error("Unable to load message translations", error)
			if (boundSession === session && webviewView === view && renderRevision === revision) {
				await view.webview.postMessage({
					command: "messageDetails",
					bundleId: bundle.id,
					revision,
					error: true,
				})
			}
		}
	}

	const throttledUpdateWebviewContent = throttle(500, updateWebviewContent)

	const controller: MessageViewController = {
		bindProject(session) {
			renderRevision++
			throttledUpdateWebviewContent.cancel({ upcomingOnly: true })
			boundSession = session
			return {
				dispose: async () => {
					if (boundSession === session) boundSession = undefined
					await queueSubscriptionTransition(async () => {
						if (subscribedSession !== session) return
						const currentSubscription = subscription
						subscription = undefined
						subscribedSession = undefined
						await currentSubscription?.unsubscribe()
						bundles = undefined
						previousBundles = undefined
					})
				},
			}
		},
		resolveWebviewView(
			view: vscode.WebviewView,
			_context: vscode.WebviewViewResolveContext<unknown>,
			token: vscode.CancellationToken
		) {
			webviewView = view
			const viewDisposables: vscode.Disposable[] = []
			let viewDisposed = false

			const disposeView = () => {
				if (viewDisposed) return
				viewDisposed = true
				const ownsCurrentView = webviewView === view
				if (ownsCurrentView) {
					webviewView = undefined
					renderRevision++
				}
				for (const disposable of viewDisposables) disposable.dispose()
				if (!ownsCurrentView) return
				throttledUpdateWebviewContent.cancel({ upcomingOnly: true })
				if (debounceTimer) clearTimeout(debounceTimer)
				void queueSubscriptionTransition(async () => {
					const currentSubscription = subscription
					subscription = undefined
					subscribedSession = undefined
					await currentSubscription?.unsubscribe()
					bundles = undefined
					previousBundles = undefined
				})
			}

			view.onDidDispose(disposeView)
			token?.onCancellationRequested?.(disposeView, undefined, viewDisposables)

			view.webview.options = {
				enableScripts: true,
			}

			view.webview.onDidReceiveMessage(
				(message) => {
					if (message.command === "expandMessage") {
						void expandMessage(view, message)
					} else if (message.command === "retryMessages") {
						void updateWebviewContent()
					} else if (message.command === "executeCommand") {
						const commandName = message.commandName
						const commandArgs = message.commandArgs

						vscode.commands.executeCommand(commandName, commandArgs)
					}
				},
				undefined,
				viewDisposables
			)

			updateMessages() // Initial update
		},
	}

	args.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(debounceUpdate),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (
				vscode.window.activeTextEditor &&
				event.document === vscode.window.activeTextEditor.document
			) {
				debounceUpdate()
			}
		}),
		vscode.workspace.onDidChangeConfiguration(updateMessages),
		CONFIGURATION.EVENTS.ON_DID_CREATE_MESSAGE.event(() => void updateMessages()),
		CONFIGURATION.EVENTS.ON_DID_EXTRACT_MESSAGE.event(() => void updateMessages()),
		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.event(() => void forceMessageRefresh()),
		CONFIGURATION.EVENTS.ON_DID_SETTINGS_VIEW_CHANGE.event(() => void updateMessages()),
		CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.event(() => void updateMessages())
	)

	return controller
}

export async function createMessageHtml(args: {
	bundle: BundleNested
	position?: {
		start: {
			line: number
			character: number
		}
		end: {
			line: number
			character: number
		}
	}
	isHighlighted: boolean
	workspaceFolder: vscode.WorkspaceFolder
	project?: InlangProject
	projectPath?: string
	locales?: readonly string[]
	lazy?: boolean
}): Promise<string> {
	const configuredLocales =
		args.locales ??
		(args.lazy
			? ((await (args.project ?? getSafeState()?.project)?.settings.get())?.locales ?? [])
			: undefined)
	const translationsTableHtml = args.lazy
		? "Loading translations..."
		: await getTranslationsTableHtml({
				bundle: args.bundle,
				workspaceFolder: args.workspaceFolder,
				project: args.project,
				locales: configuredLocales,
			})
	let searchText = args.bundle.messages
		.filter((message) => !configuredLocales || configuredLocales.includes(message.locale))
		.flatMap((message) =>
			message.variants.map((variant) =>
				getStringFromPattern({
					pattern: variant.pattern,
					locale: message.locale,
					messageId: message.id,
				})
			)
		)
		.join(" ")

	if (
		configuredLocales?.some(
			(locale) => !args.bundle.messages.some((message) => message.locale === locale)
		)
	) {
		searchText += ` ${CONFIGURATION.STRINGS.MISSING_TRANSLATION_MESSAGE}`
	}

	// Find the relative path from the workspace/git root
	const selectedProjectPath = args.projectPath ?? getSafeState()?.selectedProjectPath ?? ""
	if (!selectedProjectPath) {
		logger.warn("Unable to determine selected project path when rendering message HTML")
	}
	const relativeProjectPathFromWorkspace = selectedProjectPath.replace(
		args.workspaceFolder.uri.fsPath,
		""
	)

	const positionHtml = encodeURIComponent(JSON.stringify(args.position))
	const jumpCommand = `jumpToPosition('${args.bundle.id}', '${positionHtml}');event.stopPropagation();`
	const openCommand = `openInFink('${args.bundle.id}', '${relativeProjectPathFromWorkspace}');event.stopPropagation();`

	return `
    <div class="tree-item" data-search-text="${escapeHtml(searchText)}">
        <div class="collapsible" data-message-id="${args.bundle.id}">
            <div class="messageId">
			 	<span class="chevron codicon codicon-chevron-right"></span>
                <span><strong>#</strong></span>
                <span>${args.bundle.id}</span>
            </div>
            <div class="actionButtons">
                ${
									args.position
										? `<span title="Jump to message" onclick="${jumpCommand}"><span class="codicon codicon-magnet"></span></span>`
										: ""
								}
				<!-- Removed until we have a proper way to open in Fink with Lix host -->
                <!--<span title="Open in Fink" onclick="${openCommand}"><span class="codicon codicon-link-external"></span></span>-->
            </div>
        </div>
        <div class="content" data-bundle-id="${escapeHtml(args.bundle.id)}" data-loaded="${!args.lazy}" style="display: none;">
            ${translationsTableHtml}
        </div>
    </div>
    `
}

export function createNoMessagesFoundHtml(): string {
	return `<div class="no-messages">
                <span>No messages found. Extract text to create a message by selecting a text and using the "Extract message" quick action / command.</span>
            </div>`
}

export function createMessagesLoadingHtml(): string {
	return `<div class="loading">
				<span>Loading messages...</span>
			</div>`
}

export function getHtml(args: {
	mainContent: string
	renderRevision?: number
	webview: vscode.Webview
	extensionUri: vscode.Uri
}): string {
	const styleUri = args.webview.asWebviewUri(
		vscode.Uri.joinPath(args.extensionUri, "assets", "styles.css")
	)
	const codiconsUri = args.webview.asWebviewUri(
		vscode.Uri.joinPath(args.extensionUri, "assets", "codicon.css")
	)
	const codiconsTtfUri = args.webview.asWebviewUri(
		vscode.Uri.joinPath(args.extensionUri, "assets", "codicon.ttf")
	)

	return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <!-- Use a content security policy to only allow loading specific resources in the webview -->
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${args.webview.cspSource}; style-src ${args.webview.cspSource} 'unsafe-inline'; script-src ${args.webview.cspSource} 'unsafe-inline';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Inlang Message View</title>
            <link href="${styleUri}" rel="stylesheet" />
            <link href="${codiconsUri}" rel="stylesheet" />
			<link href="${codiconsTtfUri}" rel="stylesheet" />
        </head>
        <body>
            <input type="text" id="searchInput" placeholder="Search">
            ${args.mainContent}
            <script>
				let collapsibles = [];
				let copyButtons = [];
				const vscode = acquireVsCodeApi();
				const renderRevision = ${args.renderRevision ?? 0};
				const pendingDetails = new Set();
				const detailsQueue = [];
				let loadingDetails;
				function loadNextDetails() {
					if (loadingDetails || !detailsQueue.length) return;
					loadingDetails = detailsQueue.shift();
					vscode.postMessage({ command: 'expandMessage', bundleId: loadingDetails, revision: renderRevision });
				}
				function requestDetails(content) {
					const bundleId = content.getAttribute('data-bundle-id');
					if (content.getAttribute('data-loaded') !== 'false' || pendingDetails.has(bundleId)) return;
					pendingDetails.add(bundleId);
					detailsQueue.push(bundleId);
					loadNextDetails();
				}
				window.addEventListener('message', (event) => {
					const message = event.data;
					if (message.command !== 'messageDetails' || message.revision !== renderRevision || !pendingDetails.has(message.bundleId)) return;
					document.querySelectorAll('.content[data-bundle-id]').forEach(content => {
						if (content.getAttribute('data-bundle-id') !== message.bundleId) return;
						if (message.error) content.textContent = 'Unable to load translations. Collapse and expand to retry.';
						else { content.innerHTML = message.html; content.setAttribute('data-loaded', 'true'); }
					});
					pendingDetails.delete(message.bundleId);
					loadingDetails = undefined;
					loadNextDetails();
				});
			
				document.addEventListener('DOMContentLoaded', () => {
					collapsibles = document.querySelectorAll('.collapsible');
					copyButtons = document.querySelectorAll('.copy-btn');
					initializeSearchFunctionality();
					initializeCollapsibleItems();
					initializeCopyButtons();
				});
			
				function initializeCollapsibleItems() {
					collapsibles.forEach(collapsible => {
						const messageId = collapsible.getAttribute('data-message-id');
						const isHighlighted = collapsible.closest('.highlighted-section') !== null;
						const sectionPrefix = isHighlighted ? 'highlighted' : 'all';
						const storageKey = 'sherlock.collapsibleState.' + sectionPrefix + '.' + messageId;
				
						const storedState = localStorage.getItem(storageKey);
						const content = collapsible.nextElementSibling;
						if (storedState) {
							const isActive = storedState === 'true';
							collapsible.classList.toggle('active', isActive);
							content.style.display = isActive ? 'block' : 'none';
							if (isActive) requestDetails(content);
						} else {
							// Ensure default state is correctly set
							content.style.display = 'none';
						}
				
						collapsible.addEventListener('click', function() {
							collapsible.classList.toggle('active');
							const isExpanded = content.style.display === 'block';
							content.style.display = isExpanded ? 'none' : 'block';
							localStorage.setItem(storageKey, !isExpanded);
							if (!isExpanded) requestDetails(content);
						});
					});
				}
				
				function initializeCopyButtons() {
					copyButtons.forEach(button => {
						button.addEventListener('click', function() {
							const messageId = this.getAttribute('data-message-id');
							navigator.clipboard.writeText(messageId);
						});
					});
				}

                function initializeSearchFunctionality() {
                    const searchInput = document.getElementById('searchInput');
                    const storedSearchValue = localStorage.getItem('sherlock.searchValue') || '';
                    searchInput.value = storedSearchValue;

                    // Apply filter based on stored value on load
                    filterItems(storedSearchValue.toLowerCase());

                    searchInput.addEventListener('input', () => {
                        const searchTerm = searchInput.value.toLowerCase();
                        localStorage.setItem('sherlock.searchValue', searchTerm);
                        filterItems(searchTerm);
                    });
                }

				function filterItems(searchTerm) {
					document.querySelectorAll('.tree-item').forEach(item => {
						const messageId = item.querySelector('.collapsible').textContent.toLowerCase();
						const translationsText = (item.getAttribute('data-search-text') || '').toLowerCase();

						// Use the data-alias attribute for search
						const aliases = item.querySelectorAll('.aliases [data-alias]');
						let aliasesText = '';
						aliases.forEach(alias => {
							aliasesText += alias.getAttribute('data-alias').toLowerCase() + ' ';
						});
				
						const itemVisible = messageId.includes(searchTerm) || translationsText.includes(searchTerm) || aliasesText.includes(searchTerm);
						item.style.display = itemVisible ? '' : 'none';
					});
				}

				function openEditorView(bundleId) {
					vscode.postMessage({
						command: 'executeCommand',
						commandName: 'sherlock.openEditorView',
						commandArgs: { bundleId, context: vscode.context },
					});
				}
			
				function openInFink(bundleId, selectedProjectPath) {
					vscode.postMessage({
						command: 'executeCommand',
						commandName: 'sherlock.openInFink',
						commandArgs: { bundleId, selectedProjectPath },
					});
				}

				function jumpToPosition(bundleId, position) {
					const decodedPosition = JSON.parse(decodeURIComponent(position));
					vscode.postMessage({
						command: 'executeCommand',
						commandName: 'sherlock.jumpToPosition',
						commandArgs: { bundleId, position: decodedPosition },
					});
				}

            </script>
        </body>
        </html>
    `
}

export async function getTranslationsTableHtml(args: {
	bundle: BundleNested
	workspaceFolder: vscode.WorkspaceFolder
	project?: InlangProject
	locales?: readonly string[]
}): Promise<string> {
	const activeProject = args.project ?? getSafeState()?.project
	if (!activeProject && !args.locales) {
		logger.warn("Unable to render translations table because project is undefined")
		return '<div class="section"><span class="message">Project is still loading...</span></div>'
	}

	const configuredLocales = args.locales ?? (await activeProject!.settings.get()).locales
	const contextTableRows = configuredLocales.flatMap((locale) => {
		const message = args.bundle.messages.find((m) => m.locale === locale)

		// Handle missing translation scenario
		if (!message) {
			const missingTranslationMessage = CONFIGURATION.STRINGS.MISSING_TRANSLATION_MESSAGE
			const editCommand = `openEditorView('${args.bundle.id}')`

			return `
				<div class="section">
					<span class="languageTag"><strong>${escapeHtml(locale)}</strong></span>
					<span class="message"><button onclick="${editCommand}">${escapeHtml(missingTranslationMessage)}</button></span>
					<span class="actionButtons">
						<button title="Edit" onclick="${editCommand}"><span class="codicon codicon-edit"></span></button>
					</span>
				</div>
			`
		}

		// If message is present, map over each variant
		return message.variants.map((variant, index) => {
			const pattern = getStringFromPattern({
				pattern: variant.pattern,
				locale: message.locale,
				messageId: message.id,
			})

			const editCommand = `openEditorView('${args.bundle.id}')`

			// Create a readable string from variant matches
			const variantLabel = variant.matches
				? variant.matches
						.map((match) => {
							if (match.type === "literal-match") {
								return match.value
							}
							if (match.type === "catchall-match") {
								return "*"
							}
							return ""
						})
						.filter(Boolean)
						.join(", ")
				: undefined

			return `
				<div class="section">
					<span class="languageTag"><strong>${escapeHtml(locale)}${escapeHtml(variantLabel ? ` - ${variantLabel}` : "")}</strong></span>
					<span class="message"><button onclick="${editCommand}">${escapeHtml(pattern)}</button></span>
					<span class="actionButtons">
						<button title="Edit" onclick="${editCommand}"><span class="codicon codicon-edit"></span></button>
					</span>
				</div>
			`
		})
	})

	return `<div class="table">${contextTableRows.join("")}</div>`
}

export async function messageView(args: {
	workspaceFolder: vscode.WorkspaceFolder
	extensionUri: vscode.Uri
	subscriptions: vscode.Disposable[]
}) {
	const provider = createMessageWebviewProvider({
		workspaceFolder: args.workspaceFolder,
		extensionUri: args.extensionUri,
		subscriptions: args.subscriptions,
	})
	args.subscriptions.push(vscode.window.registerWebviewViewProvider("messageView", provider))
	return provider
}
