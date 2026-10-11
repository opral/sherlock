import * as vscode from "vscode"
import { MarkdownString, Uri } from "vscode"
import { state } from "../utilities/state.js"
import { getStringFromPattern } from "../utilities/messages/query.js"
import { INTERPOLATE } from "../configuration.js"
import { escapeHtml } from "../utilities/utils.js"
import { checkBundle, selectorGroups, type IdeExtensionConfig } from "@inlang/sdk"
import {
	PROBLEM_CHECKS,
	isTranslationProblem,
	problemText,
} from "../utilities/editor/sherlock-editor-app/src/problems/translationProblems.js"
import type { InlangProject } from "@inlang/sdk"
import { previewVariant } from "../utilities/messages/previewVariant.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"

const MISSING_TRANSLATION_MESSAGE = "[missing]"

type ContextTableRow = {
	locale: string
	message: string
	bundleId: string
	/** what the SDK's checks find in the translation: "Missing {name}", "Missing form: few" */
	problems?: string[]
	editCommand?: Uri
	openInFinkCommand?: Uri
}

function renderTranslationRow(row: ContextTableRow) {
	const openInFinkLink = row.openInFinkCommand
		? `<a href="${row.openInFinkCommand}">$(link-external)</a>`
		: ""

	const actionCommandLink = row.editCommand ? `<a href="${row.editCommand}">$(edit)</a>` : ""

	const messageListing = `<td><strong>${escapeHtml(row.locale)}&nbsp;</strong></td><td>${escapeHtml(
		row.message
	)}</td>`
	const actionCommandCell = actionCommandLink ? `<td>&nbsp;&nbsp;${actionCommandLink}</td>` : ""
	const openInFinkCell = openInFinkLink ? `<td>&nbsp;${openInFinkLink}</td>` : ""
	const problemsRow = row.problems?.length
		? `<tr><td></td><td>$(warning) ${row.problems.map(escapeHtml).join(" · ")}</td></tr>`
		: ""

	return `<tr>${messageListing}${actionCommandCell}${openInFinkCell}</tr>${problemsRow}`
}

export async function contextTooltip(
	referenceMessage: Awaited<
		ReturnType<IdeExtensionConfig["messageReferenceMatchers"][number]>
	>[number],
	project: InlangProject | undefined = state().project
) {
	if (!project) return

	// @ts-ignore TODO: Introduce deprecation message for messageId
	referenceMessage.bundleId = referenceMessage.bundleId || referenceMessage.messageId
	// resolve message from id or alias
	const bundle = await selectBundleById(project, referenceMessage.bundleId)

	if (!bundle) {
		return undefined // Return early if message is not found
	}

	// Get the configured language tags
	const settings = await project.settings.get()
	const configuredLanguageTags = settings?.locales || []
	const problems = translationProblems({
		bundle,
		locales: configuredLanguageTags,
		referenceLocale: settings.baseLocale,
	})

	// Generate rows for each configured language tag
	const contextTableRows: ContextTableRow[] = await Promise.all(
		configuredLanguageTags.map(async (locale) => {
			const message = bundle.messages.find((m) => m.locale === locale)

			// Get the catchall variant or first variant as fallback
			const variant = previewVariant(message?.variants)

			let m = MISSING_TRANSLATION_MESSAGE

			if (message && variant) {
				m = getStringFromPattern({
					pattern: variant.pattern,
					locale: message.locale,
					messageId: message.id,
				})
			}

			const editCommand = Uri.parse(
				INTERPOLATE.COMMAND_URI(
					"OPEN_EDITOR_VIEW",
					encodeURIComponent(JSON.stringify({ bundleId: referenceMessage.bundleId }))
				)
			)
			// const openInFinkCommand = Uri.parse(
			// 	INTERPOLATE.COMMAND_URI(
			// 		"OPEN_IN_FINK",
			// 		encodeURIComponent(JSON.stringify([{ bundleId: referenceMessage.bundleId, context }]))
			// 	)
			// )

			return {
				locale,
				message: m,
				bundleId: referenceMessage.bundleId,
				problems: message ? problems.get(locale) : undefined,
				editCommand,
				// openInFinkCommand,
			}
		})
	)

	const contextTable = `<table>${contextTableRows.map(renderTranslationRow).join("")}</table>`
	const tooltip = new MarkdownString(contextTable, true)

	tooltip.supportHtml = true
	tooltip.isTrusted = true
	tooltip.supportThemeIcons = true

	return tooltip
}

/**
 * The problems of each translation of a bundle, from the SDK's checks: missing or unknown
 * variables, missing markup, empty forms, and plural or select forms a language still needs.
 * A missing translation is the "[missing]" text itself.
 */
export function translationProblems(args: {
	bundle: NonNullable<Awaited<ReturnType<typeof selectBundleById>>>
	locales: string[]
	referenceLocale: string
}): Map<string, string[]> {
	const byLocale = new Map<string, string[]>()
	const add = (locale: string, text: string) => {
		const texts = byLocale.get(locale) ?? []
		if (!texts.includes(text)) byLocale.set(locale, [...texts, text])
	}
	const missingForms = new Map<string, string[]>()
	try {
		for (const diagnostic of checkBundle({
			bundle: args.bundle,
			locales: args.locales,
			referenceLocale: args.referenceLocale,
			checks: [...PROBLEM_CHECKS, "missing-variant"],
		})) {
			if (!diagnostic.locale) continue
			if (isTranslationProblem(diagnostic)) {
				add(diagnostic.locale, problemText(diagnostic))
			} else if (diagnostic.checkId === "missing-variant") {
				const message = args.bundle.messages.find((m) => m.id === diagnostic.messageId)
				if (!message) continue
				const label = selectorGroups(message, args.bundle.declarations, {
					variants: [{ matches: diagnostic.matches }],
				})
					.map((group) => {
						const key = group.keyOf({ matches: diagnostic.matches })
						return key !== "*" ? key : group.isPlural ? "other" : "any other"
					})
					.join(", ")
				missingForms.set(diagnostic.locale, [...(missingForms.get(diagnostic.locale) ?? []), label])
			}
		}
		for (const [locale, labels] of missingForms) {
			add(locale, `${labels.length === 1 ? "Missing form" : "Missing forms"}: ${labels.join("; ")}`)
		}
	} catch (error) {
		console.error("Checking the translations failed", error)
	}
	return byLocale
}
