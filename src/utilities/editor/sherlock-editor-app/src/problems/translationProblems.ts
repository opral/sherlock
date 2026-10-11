/**
 * Text for the SDK's translation checks, shared by the editor webview and the hover of the
 * extension. Type imports only: the extension and the webview bundle their own copy of the SDK.
 */
import type { CheckDiagnostic } from "@inlang/sdk"

/** The checks that are about the text of a translation (not missing translations or forms). */
export const PROBLEM_CHECKS = [
	"missing-variable",
	"unknown-variable",
	"missing-markup",
	"empty-variant",
	"missing-selector",
] as const

export type TranslationProblem = Extract<
	CheckDiagnostic,
	{ checkId: (typeof PROBLEM_CHECKS)[number] }
>

export function isTranslationProblem(
	diagnostic: CheckDiagnostic
): diagnostic is TranslationProblem {
	return (PROBLEM_CHECKS as readonly string[]).includes(diagnostic.checkId)
}

/** The reference's exact numbers (=0) a translation has no form for: a plural alone can't match them. */
export function missingExactNumbers(problem: TranslationProblem): readonly string[] | undefined {
	return problem.checkId === "missing-selector" &&
		problem.values.length > 0 &&
		problem.values.every((value) => /^-?\d+(\.\d+)?$/.test(value))
		? problem.values
		: undefined
}

/** "Missing {name}", "Unknown {totl} – did you mean {total}?", "Empty form", … */
export function problemText(problem: TranslationProblem): string {
	switch (problem.checkId) {
		case "empty-variant":
			return "Empty form"
		case "missing-selector": {
			const numbers = missingExactNumbers(problem)
			return numbers
				? `No form for ${numbers.map((value) => `=${value}`).join(", ")} – add it in Plural & select`
				: `Not split by {${problem.name}} – add it in Plural & select`
		}
		case "missing-variable":
			return `Missing {${problem.name}}`
		case "missing-markup":
			return `Missing <${problem.name}>`
		case "unknown-variable":
			return problem.suggestion
				? `Unknown {${problem.name}} – did you mean {${problem.suggestion}}?`
				: `Unknown {${problem.name}}`
	}
}
