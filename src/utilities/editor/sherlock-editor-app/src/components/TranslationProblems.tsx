import { selectorGroups } from "@inlang/sdk/browser"
import { Icon } from "./icons.js"
import type { Declarations, EditorMessage, EditorVariant } from "./fields.js"
import { problemText, type TranslationProblem } from "../problems/translationProblems.js"

/**
 * "one", "female, other", "0": the label of a form as `<inlang-message-forms>` shows it.
 */
export function formLabel(
	variant: EditorVariant,
	message: Pick<EditorMessage, "locale" | "selectors">,
	declarations: Declarations
) {
	return selectorGroups(message, declarations, { variants: [variant] })
		.map((group) => {
			const key = group.keyOf(variant)
			return key !== "*" ? key : group.isPlural ? "other" : "any other"
		})
		.join(", ")
}

/**
 * The problems of a translation below its field: "Missing {name}", "Unknown {totl} – did you
 * mean {total}?". A problem of another form names that form and selects it when clicked.
 */
export function TranslationProblems({
	problems,
	message,
	declarations,
	selectedVariantId,
	onSelect,
}: {
	problems: TranslationProblem[] | undefined
	message: EditorMessage
	declarations: Declarations
	selectedVariantId: string | undefined
	onSelect: (variantId: string) => void
}) {
	if (!problems?.length) return null
	const multipleForms = message.variants.length > 1
	// the shown form first: that is the text of the field
	const sorted = [...problems].sort(
		(a, b) =>
			Number("variantId" in b && b.variantId === selectedVariantId) -
			Number("variantId" in a && a.variantId === selectedVariantId)
	)
	return (
		<ul className="problems" aria-label={`Problems of the ${message.locale} translation`}>
			{sorted.map((problem) => {
				const variantId = "variantId" in problem ? problem.variantId : undefined
				const variant = message.variants.find((v) => v.id === variantId)
				const key = `${problem.checkId}:${variantId}:${"name" in problem ? problem.name : ""}:${
					"selector" in problem ? problem.selector : ""
				}`
				const text = problemText(problem)
				return (
					<li key={key} className="problem" title={problem.message}>
						<Icon name="warning" />
						{multipleForms && variant && variant.id !== selectedVariantId ? (
							<>
								<button
									type="button"
									className="link"
									title="Show this form"
									onClick={() => onSelect(variant.id)}
								>
									{formLabel(variant, message, declarations)}
								</button>
								{`: ${text}`}
							</>
						) : (
							text
						)}
					</li>
				)
			})}
		</ul>
	)
}
