/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as vscode from "vscode"
import { resolveLintRules } from "./lintRuleResolver.js"
import type { FileSystem } from "../utilities/fs/createFileSystemMapper.js"
import { getExtensionApi } from "../utilities/helper.js"
import type { InlangProject } from "@inlang/sdk"
import {
	deactivateBeforeClose,
	type Disposable,
	type ProjectSession,
} from "../utilities/project/projectSession.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"
import { handleError } from "../utilities/utils.js"
import { CONFIGURATION } from "../configuration.js"

export async function linterDiagnostics(args: {
	subscriptions: Disposable[]
	fs: FileSystem
	session: ProjectSession<InlangProject>
}) {
	const linterDiagnosticCollection = vscode.languages.createDiagnosticCollection("inlang-lint")
	args.subscriptions.push(linterDiagnosticCollection)
	const eventSubscriptions: vscode.Disposable[] = []

	function updateLintDiagnostics() {
		void (async () => {
			const result = await args.session.runTask(async () => {
				const project = args.session.project
				const activeTextEditor = vscode.window.activeTextEditor
				if (!activeTextEditor) return

				const documentText = activeTextEditor.document.getText()
				const extensionApi = await getExtensionApi(project)

				if (!extensionApi) return

				// Process messageReferenceMatchers to match bundles
				const messageReferenceMatchers = extensionApi.messageReferenceMatchers ?? []
				const activeLintRules = await resolveLintRules(project)
				const diagnostics: vscode.Diagnostic[] = []

				// Run each matcher on the document text
				const wrappedLints = messageReferenceMatchers.map(async (matcher) => {
					const bundles = await matcher({ documentText })

					const diagnosticsIndex: Record<string, Record<string, vscode.Diagnostic[]>> = {}

					for (const bundle of bundles) {
						// @ts-ignore TODO: Introduce deprecation message for messageId
						bundle.bundleId = bundle.bundleId || bundle.messageId
						// Retrieve the bundle and messages
						const _bundle = await selectBundleById(project, bundle.bundleId)

						if (_bundle) {
							for (const lintRule of activeLintRules) {
								// @ts-ignore TODO: Introduce deprecation message for messageId
								const lintResults = await lintRule.ruleFn(bundle.bundleId, project)

								for (const result of lintResults) {
									const diagnosticRange = new vscode.Range(
										new vscode.Position(
											bundle.position.start.line - 1,
											bundle.position.start.character - 1
										),
										new vscode.Position(
											bundle.position.end.line - 1,
											bundle.position.end.character - 1
										)
									)

									const diagnostic = new vscode.Diagnostic(
										diagnosticRange,
										`[${result.code}] - ${result.description}`,
										result.severity
									)

									// Create index for diagnostics if missing
									if (!diagnosticsIndex[bundle.bundleId]) {
										diagnosticsIndex[bundle.bundleId] = {}
									}

									// Store the diagnostics
									const rangeIndex = getRangeIndex(diagnostic.range)
									if (!diagnosticsIndex[bundle.bundleId]![rangeIndex]) {
										diagnosticsIndex[bundle.bundleId]![rangeIndex] = []
									}
									// Typescript doesn't understand that diagnosticsIndex[bundle.bundleId]![rangeIndex] is an empty array if it doesn't exist
									// @ts-expect-error
									diagnosticsIndex[bundle.bundleId]![rangeIndex].push(diagnostic)
								}
							}
						}
					}

					// Collect all diagnostics
					diagnostics.push(...flattenDiagnostics(diagnosticsIndex))
				})

				await Promise.all(wrappedLints || [])

				return { uri: activeTextEditor.document.uri, diagnostics }
			})
			if (result.status === "completed" && result.value) {
				linterDiagnosticCollection.set(result.value.uri, result.value.diagnostics)
			}
		})().catch(handleError)
	}

	// Trigger diagnostics on active text editor change and text document change
	vscode.window.onDidChangeActiveTextEditor(updateLintDiagnostics, undefined, eventSubscriptions)
	vscode.workspace.onDidChangeTextDocument(
		(event) => {
			if (event.document === vscode.window.activeTextEditor?.document) {
				updateLintDiagnostics()
			}
		},
		undefined,
		eventSubscriptions
	)
	eventSubscriptions.push(
		CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.event(() => updateLintDiagnostics())
	)
	args.subscriptions.push(...eventSubscriptions.map(deactivateBeforeClose))
}

// Helper function to get a unique index for a range
function getRangeIndex(range: vscode.Diagnostic["range"]) {
	return `${range.start.line}${range.start.character}${range.end.line}${range.end.character}`
}

// Helper function to flatten diagnostics into an array
function flattenDiagnostics(
	index: Record<string, Record<string, vscode.Diagnostic[]>>
): vscode.Diagnostic[] {
	let result: vscode.Diagnostic[] = []

	const messageIds = Object.keys(index)

	for (const messageId of messageIds) {
		result = [...result, ...Object.values(index[messageId]!).flat()]
	}

	return result
}
