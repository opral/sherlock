import type { VariantRow } from "@inlang/sdk"

/** A catch-all match, or a plural's explicit `other` key (the shape Paraglide's files import). */
function isOther(match: VariantRow["matches"][number]) {
	return match.type === "catchall-match" || match.value === "other"
}

/**
 * The variant to preview a message with: the catch-all form ("other"), whose matches are all
 * catch-alls (or `other`). A form for an exact number (`=0`) also has a catch-all match (for the
 * plural), so "any catch-all" is not enough. Falls back to a variant with a catch-all, then the
 * first one.
 */
export function previewVariant<V extends Pick<VariantRow, "matches">>(
	variants: readonly V[] | undefined
): V | undefined {
	if (!variants?.length) return undefined
	return (
		variants.find((variant) => variant.matches.every(isOther)) ??
		variants.find((variant) => variant.matches.some(isOther)) ??
		variants[0]
	)
}
