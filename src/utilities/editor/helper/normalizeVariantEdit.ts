import type { BundleNested, InlangProject, Pattern, VariantRow } from "@inlang/sdk"
import { textToPattern } from "../../messages/pattern.js"
import { normalizeBundle } from "./normalizeBundle.js"

export type VariantEdit = {
	project: InlangProject
	bundle: BundleNested
	variant: VariantRow
	pattern: Pattern
	editorText?: string
}

/** Parse an edit with all sibling variants/locales present and keep all derived model metadata. */
export async function normalizeVariantChange(args: VariantEdit): Promise<BundleNested> {
	const { project, variant } = args
	const bundle = structuredClone(args.bundle)
	const message = bundle.messages.find((entry) => entry.id === variant.message_id)
	if (!message) throw new Error(`Message for variant ${variant.id} was not found in ${bundle.id}.`)
	const pattern =
		args.editorText === undefined ? args.pattern : textToPattern(args.editorText, variant.pattern)
	const edited = { ...variant, pattern }
	const index = message.variants.findIndex((entry) => entry.id === variant.id)
	if (index === -1) message.variants.push(edited)
	else message.variants[index] = edited
	try {
		return await normalizeBundle(project, bundle, variant.id)
	} catch (cause) {
		throw new Error(
			`Could not parse translation "${bundle.id}" (${message.locale}, variant ${variant.id}): ${String(cause)}`,
			{ cause }
		)
	}
}

/** Compatibility for callers that only need the edited pattern. Mutations persist the whole change. */
export async function normalizeVariantEdit(args: VariantEdit): Promise<Pattern> {
	const result = await normalizeVariantChange(args)
	const message = result.messages.find((entry) => entry.id === args.variant.message_id)
	const variant = message?.variants.find((entry) => entry.id === args.variant.id)
	if (!variant)
		throw new Error(`The resource plugin did not return edited variant ${args.variant.id}.`)
	return variant.pattern
}
