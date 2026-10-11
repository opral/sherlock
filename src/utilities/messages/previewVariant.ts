import type { VariantRow } from "@inlang/sdk"

/**
 * The variant to preview a message with: the catch-all form ("other"), whose matches are all
 * catch-alls. A form for an exact number (`=0`) also has a catch-all match (for the plural), so
 * "any catch-all" is not enough. Falls back to a variant with a catch-all, then the first one.
 */
export function previewVariant<V extends Pick<VariantRow, "matches">>(
	variants: readonly V[] | undefined
): V | undefined {
	if (!variants?.length) return undefined
	return (
		variants.find((variant) => variant.matches.every((match) => match.type === "catchall-match")) ??
		variants.find((variant) => variant.matches.some((match) => match.type === "catchall-match")) ??
		variants[0]
	)
}
