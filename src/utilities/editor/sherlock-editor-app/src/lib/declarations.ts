import type { BundleNested, Pattern } from "@inlang/sdk"

/** The variables a bundle uses: in patterns, as selectors and in local declarations. */
export function usedVariables(bundle: BundleNested) {
	const used = new Set<string>()
	for (const message of bundle.messages) {
		for (const selector of message.selectors) used.add(selector.name)
		for (const variant of message.variants) {
			for (const element of variant.pattern) {
				if (element.type === "expression" && element.arg.type === "variable-reference") {
					used.add(element.arg.name)
				}
			}
		}
	}
	for (const declaration of bundle.declarations) {
		if (
			declaration.type === "local-variable" &&
			declaration.value.arg.type === "variable-reference"
		) {
			used.add(declaration.value.arg.name)
		}
	}
	return used
}

/**
 * Declares the variables a pattern uses that the bundle doesn't know yet (a typed `{count}`), and
 * drops the ones this editor declared that nothing uses any more (`{nme}` corrected to `{name}`).
 * Declarations the bundle had before are never removed.
 */
export function updateDeclarations(
	bundle: BundleNested,
	pattern: Pattern,
	declaredHere: Set<string>
): BundleNested["declarations"] {
	const declarations = [...bundle.declarations]
	for (const element of pattern) {
		if (element.type !== "expression" || element.arg.type !== "variable-reference") continue
		const name = element.arg.name
		if (!declarations.some((declaration) => declaration.name === name)) {
			declarations.push({ type: "input-variable", name })
			declaredHere.add(name)
		}
	}
	const used = usedVariables(bundle)
	return declarations.filter((declaration) => {
		if (!declaredHere.has(declaration.name) || used.has(declaration.name)) return true
		declaredHere.delete(declaration.name)
		return false
	})
}
