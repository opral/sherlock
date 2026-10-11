import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { InlangPatternEditor } from "@inlang/editor-component"
import { checkBundle } from "@inlang/sdk/browser"
import type { BundleNested, Pattern, ProjectSettings } from "@inlang/sdk"
import { v7 as uuidv7 } from "uuid"
import { vscode } from "../utils/vscode.js"
import { diffBundles } from "../lib/diffBundles.js"
import { MessageForms, PatternField, type EditorMessage, type EditorVariant } from "./fields.js"
import { TranslationProblems } from "./TranslationProblems.js"
import { SelectorPanel } from "./SelectorPanel.js"
import { Icon } from "./icons.js"
import {
	PROBLEM_CHECKS,
	isTranslationProblem,
	type TranslationProblem,
} from "../problems/translationProblems.js"

function isEmptyPattern(pattern: Pattern) {
	return pattern.every((element) => element.type === "text" && element.value.trim() === "")
}

function languageName(locale: string) {
	try {
		return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(locale)
	} catch {
		return undefined
	}
}

/** Declares the variables a pattern uses that the bundle doesn't know yet, e.g. a typed `{count}`. */
function declareVariables(bundle: BundleNested, pattern: Pattern): BundleNested["declarations"] {
	const declarations = [...bundle.declarations]
	for (const element of pattern) {
		if (element.type !== "expression" || element.arg.type !== "variable-reference") continue
		const name = element.arg.name
		if (!declarations.some((declaration) => declaration.name === name)) {
			declarations.push({ type: "input-variable", name })
		}
	}
	return declarations
}

/**
 * The editor of one bundle: a row per language with the translation, its forms (plural, select)
 * and the problems the SDK's checks find, plus "Plural & select" for the whole bundle.
 *
 * The extension owns the data. The editor keeps its own copy to stay responsive while typing,
 * sends the rows it changed and replaces its copy when the extension sends a new bundle.
 */
export default function Editor({
	bundle: stored,
	settings,
}: {
	bundle: BundleNested
	settings: ProjectSettings
}) {
	const [bundle, setBundle] = useState(stored)
	const current = useRef(stored)
	// a new bundle from the extension replaces the editor's copy
	useEffect(() => {
		current.current = stored
		setBundle(stored)
	}, [stored])

	const { locales, baseLocale } = settings
	const [selected, setSelected] = useState<Record<string, string>>({})
	const [showSelectors, setShowSelectors] = useState(false)
	const [error, setError] = useState<string>()
	const fields = useRef(new Map<string, InlangPatternEditor>())
	const focusVariant = useRef<string>(undefined)
	useLayoutEffect(() => {
		const field = focusVariant.current && fields.current.get(focusVariant.current)
		if (!field) return
		focusVariant.current = undefined
		field.focus()
	})

	// Messages of languages without a translation yet. The ids stay the same while the editor is
	// open, so that typing into a draft creates the message once.
	const draftIds = useRef(new Map<string, { message: string; variant: string }>())
	const reference = bundle.messages.find((message) => message.locale === baseLocale)
	const drafts = useMemo(() => {
		const selectors = reference?.selectors ?? []
		return locales
			.filter((locale) => !bundle.messages.some((message) => message.locale === locale))
			.map((locale): EditorMessage => {
				const key = `${bundle.id}\u0000${locale}`
				let ids = draftIds.current.get(key)
				if (!ids) {
					ids = { message: uuidv7(), variant: uuidv7() }
					draftIds.current.set(key, ids)
				}
				return {
					id: ids.message,
					bundle_id: bundle.id,
					locale,
					selectors: structuredClone(selectors),
					// a plural or select starts without forms: "+ Add form" adds them one by one
					variants:
						selectors.length > 0
							? []
							: [{ id: ids.variant, message_id: ids.message, matches: [], pattern: [] }],
				}
			})
	}, [bundle, locales, reference?.selectors])

	const problems = useMemo(() => {
		const byLocale = new Map<string, TranslationProblem[]>()
		try {
			for (const diagnostic of checkBundle({
				bundle,
				locales,
				referenceLocale: baseLocale,
				checks: [...PROBLEM_CHECKS],
			})) {
				if (!isTranslationProblem(diagnostic) || !diagnostic.locale) continue
				byLocale.set(diagnostic.locale, [...(byLocale.get(diagnostic.locale) ?? []), diagnostic])
			}
		} catch (e) {
			console.error("Checking the bundle failed", e)
		}
		return byLocale
	}, [bundle, locales, baseLocale])

	/** Shows `next`, and sends the rows that differ from the editor's copy to the extension. */
	const commit = (next: BundleNested, options: { persist: boolean }) => {
		const changes = diffBundles(current.current, next)
		if (changes.length === 0) return
		current.current = next
		setBundle(next)
		setError(undefined)
		vscode.postMessage({ command: "apply-changes", changes, persist: options.persist })
	}

	/** The bundle with `message` (a draft or a stored message) replaced by `update(message)`. */
	const withMessage = (
		message: EditorMessage,
		update: (message: EditorMessage) => EditorMessage
	): BundleNested => {
		const base = current.current
		const exists = base.messages.some((m) => m.id === message.id)
		return {
			...base,
			messages: exists
				? base.messages.map((m) => (m.id === message.id ? update(m) : m))
				: [...base.messages, update(structuredClone(message))],
		}
	}

	const editPattern = (message: EditorMessage, variantId: string, pattern: Pattern) => {
		const next = withMessage(message, (m) => ({
			...m,
			variants: m.variants.map((v) => (v.id === variantId ? { ...v, pattern } : v)),
		}))
		commit({ ...next, declarations: declareVariables(next, pattern) }, { persist: false })
	}

	const addForm = (message: EditorMessage, matches: EditorVariant["matches"]) => {
		const id = uuidv7()
		focusVariant.current = id
		// rendered (and focused) before the click's task ends, so that no key typed right after is lost
		flushSync(() => {
			commit(
				withMessage(message, (m) => ({
					...m,
					variants: [...m.variants, { id, message_id: m.id, matches, pattern: [] }],
				})),
				{ persist: true }
			)
			setSelected((s) => ({ ...s, [message.locale]: id }))
		})
	}

	const deleteForm = (message: EditorMessage, variantId: string) => {
		commit(
			withMessage(message, (m) => ({
				...m,
				variants: m.variants.filter((v) => v.id !== variantId),
			})),
			{ persist: true }
		)
	}

	const persist = () => vscode.postMessage({ command: "persist-edit" })

	return (
		<main className="editor">
			<header className="editor-header">
				<h1 className="bundle-id" title={bundle.id}>
					{bundle.id}
				</h1>
				<div className="header-actions">
					<button
						type="button"
						className={showSelectors ? "button-secondary pressed" : "button-secondary"}
						aria-expanded={showSelectors}
						onClick={() => setShowSelectors((open) => !open)}
						title="Choose the text by a number (plural) or a value (select), in every language"
					>
						Plural &amp; select
					</button>
					<button
						type="button"
						className="icon-button danger"
						title="Delete this message in every language"
						aria-label="Delete message"
						onClick={() => vscode.postMessage({ command: "delete-bundle", id: bundle.id })}
					>
						<Icon name="trash" />
					</button>
				</div>
			</header>

			{showSelectors && (
				<SelectorPanel
					bundle={bundle}
					referenceLocale={baseLocale}
					createId={uuidv7}
					onChange={(next) => commit(next, { persist: true })}
					onError={setError}
				/>
			)}

			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}

			<div className="rows">
				{locales.map((locale) => {
					const message =
						bundle.messages.find((m) => m.locale === locale) ??
						drafts.find((m) => m.locale === locale)!
					const isDraft = !bundle.messages.some((m) => m.id === message.id)
					const withForms = message.selectors.length > 0 || message.variants.length > 1
					const variant =
						message.variants.find((v) => v.id === selected[locale]) ?? message.variants[0]
					const name = languageName(locale)
					const isReference = locale === baseLocale
					const empty = message.variants.every((v) => isEmptyPattern(v.pattern))
					const referenceHasText =
						!!reference && reference.variants.some((v) => !isEmptyPattern(v.pattern))
					const showMachineTranslate = !isReference && empty && referenceHasText && !withForms
					return (
						<section className="row" key={locale} data-locale={locale}>
							<div className="row-locale" title={name}>
								<span className="locale">{locale}</span>
								{isReference && <span className="tag">ref</span>}
							</div>
							<div className="row-body">
								{withForms && (
									<MessageForms
										message={message}
										declarations={bundle.declarations}
										referenceVariants={isReference ? undefined : reference?.variants}
										selectedVariantId={variant?.id ?? ""}
										onSelect={(variantId) => setSelected((s) => ({ ...s, [locale]: variantId }))}
										onAdd={(matches) => addForm(message, matches)}
									/>
								)}
								{variant && (
									<div className="field-row">
										<PatternField
											key={variant.id}
											variant={variant}
											declarations={bundle.declarations}
											label={`${name ?? locale} translation`}
											placeholder={isReference ? "Enter text…" : `Translate to ${name ?? locale}…`}
											fields={fields.current}
											onChange={(variantId, pattern) => editPattern(message, variantId, pattern)}
											onBlur={persist}
										/>
										{showMachineTranslate && (
											<button
												type="button"
												className="machine-translate"
												title="Machine translate: AI translation that keeps your tone of voice and terminology is coming to inlang Cloud"
												aria-label="Machine translate"
												onClick={() =>
													vscode.postMessage({ command: "open-cloud", source: "editor" })
												}
											>
												<Icon name="sparkle" />
												<span className="machine-translate-label">Machine translate…</span>
											</button>
										)}
										{withForms && (
											<span className="row-slot">
												{message.variants.length > 1 && (
													<button
														type="button"
														className="icon-button"
														aria-label={`Delete this ${locale} form`}
														title="Delete this form"
														onClick={() => deleteForm(message, variant.id)}
													>
														<Icon name="trash" />
													</button>
												)}
											</span>
										)}
									</div>
								)}
								{!isDraft && (
									<TranslationProblems
										problems={problems.get(locale)}
										message={message}
										declarations={bundle.declarations}
										selectedVariantId={variant?.id}
										onSelect={(variantId) => setSelected((s) => ({ ...s, [locale]: variantId }))}
									/>
								)}
							</div>
						</section>
					)
				})}
			</div>
		</main>
	)
}
