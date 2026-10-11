import type { BundleNested, MessageRow, VariantRow } from "@inlang/sdk"
import type { ChangeEventDetail } from "@inlang/editor-component"

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function messageRow(message: BundleNested["messages"][number]): MessageRow {
	return {
		id: message.id,
		bundle_id: message.bundle_id,
		locale: message.locale,
		selectors: message.selectors,
	}
}

function variantRow(variant: VariantRow): VariantRow {
	return {
		id: variant.id,
		message_id: variant.message_id,
		matches: variant.matches,
		pattern: variant.pattern,
	}
}

/**
 * The rows that changed from `previous` to `next`, as the change events the extension writes:
 * the bundle's declarations, messages and variants that were added, changed or removed.
 *
 * Only these rows are written, so a structural edit (a selector added to every language) does not
 * rewrite rows the editor did not touch. Messages are written before their variants, and variants
 * are deleted before their messages.
 */
export function diffBundles(previous: BundleNested, next: BundleNested): ChangeEventDetail[] {
	const changes: ChangeEventDetail[] = []
	if (!same(previous.declarations, next.declarations)) {
		changes.push({
			entity: "bundle",
			entityId: next.id,
			newData: { id: next.id, declarations: next.declarations },
		})
	}
	const previousMessages = new Map(previous.messages.map((message) => [message.id, message]))
	const nextMessages = new Map(next.messages.map((message) => [message.id, message]))
	const previousVariants = new Map(
		previous.messages.flatMap((message) => message.variants).map((variant) => [variant.id, variant])
	)
	const nextVariants = new Map(
		next.messages.flatMap((message) => message.variants).map((variant) => [variant.id, variant])
	)

	for (const message of next.messages) {
		const before = previousMessages.get(message.id)
		if (!before || !same(messageRow(before), messageRow(message))) {
			changes.push({ entity: "message", entityId: message.id, newData: messageRow(message) })
		}
	}
	for (const variant of nextVariants.values()) {
		const before = previousVariants.get(variant.id)
		if (!before || !same(variantRow(before), variantRow(variant))) {
			changes.push({ entity: "variant", entityId: variant.id, newData: variantRow(variant) })
		}
	}
	for (const variant of previousVariants.values()) {
		if (!nextVariants.has(variant.id)) changes.push({ entity: "variant", entityId: variant.id })
	}
	for (const message of previous.messages) {
		if (!nextMessages.has(message.id)) changes.push({ entity: "message", entityId: message.id })
	}
	return changes
}
