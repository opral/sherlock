import type { BundleNested, InlangPlugin, InlangProject, VariantRow } from "@inlang/sdk"
import { isEqual } from "lodash-es"
import { v7 as uuid } from "uuid"
import { unsupportedPatternTypes } from "../../messages/pattern.js"

async function resourcePlugin(project: InlangProject): Promise<InlangPlugin | undefined> {
	const settings = await project.settings.get()
	const plugins = (await project.plugins.get()).filter(
		(plugin) => plugin.exportFiles && plugin.importFiles
	)
	const configured = plugins.filter((plugin) => settings[plugin.key] !== undefined)
	if (configured.length === 1) return configured[0]
	if (plugins.length > 1)
		throw new Error(
			"Multiple resource plugins are configured; the translation's parser is ambiguous."
		)
	return plugins[0]
}

/** Model variants may be aliases for one resource entry (for example i18next _zero). */
async function findStorageAliases(
	plugin: InlangPlugin,
	settings: Awaited<ReturnType<InlangProject["settings"]["get"]>>,
	bundle: BundleNested,
	variantId: string
): Promise<Set<string>> {
	const owner = bundle.messages.find((message) =>
		message.variants.some((variant) => variant.id === variantId)
	)
	const selected = owner?.variants.find((variant) => variant.id === variantId)
	const aliases = new Set([variantId])
	if (!owner || !selected || !plugin.exportFiles || owner.variants.length < 2) return aliases
	const exportSlot = async (variant: VariantRow) => {
		const files = await plugin.exportFiles!({
			bundles: [{ id: bundle.id, declarations: bundle.declarations }],
			messages: [
				{
					id: owner.id,
					bundleId: owner.bundle_id,
					locale: owner.locale,
					selectors: owner.selectors,
				},
			],
			variants: [
				{ id: variant.id, messageId: variant.message_id, matches: variant.matches, pattern: [] },
			],
			settings: structuredClone(settings),
		})
		// A missing export does not establish a shared resource identity.
		if (!files.length) return undefined
		return JSON.stringify(
			files
				.map((file) => ({
					locale: file.locale,
					name: file.name,
					metadata: file.metadata,
					content: Array.from(file.content),
				}))
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
		)
	}
	const slot = await exportSlot(selected)
	if (slot === undefined) return aliases
	for (const sibling of owner.variants)
		if (sibling.id !== selected.id && (await exportSlot(sibling)) === slot) aliases.add(sibling.id)
	return aliases
}

export async function storageAliases(
	project: InlangProject,
	bundle: BundleNested,
	variantId: string
): Promise<Set<string>> {
	const plugin = await resourcePlugin(project)
	if (!plugin) return new Set([variantId])
	return findStorageAliases(plugin, await project.settings.get(), bundle, variantId)
}

/** Canonicalize the complete resource context, including declarations and shared storage aliases. */
export async function normalizeBundle(
	project: InlangProject,
	input: BundleNested,
	editedVariantId?: string
): Promise<BundleNested> {
	const bundle = structuredClone(input)
	for (const message of bundle.messages)
		for (const variant of message.variants) {
			const unsupported = unsupportedPatternTypes(variant.pattern)
			if (unsupported.length)
				throw new Error(
					`Translation "${bundle.id}" (${message.locale}, variant ${variant.id}) contains unsupported pattern types: ${unsupported.join(", ")}.`
				)
		}
	const plugin = await resourcePlugin(project)
	if (!plugin?.exportFiles || !plugin.importFiles) return bundle
	const settings = await project.settings.get()

	if (editedVariantId) {
		const aliases = await findStorageAliases(plugin, settings, bundle, editedVariantId)
		const variants = bundle.messages.flatMap((message) => message.variants)
		const edited = variants.find((variant) => variant.id === editedVariantId)
		if (edited)
			for (const alias of variants)
				if (aliases.has(alias.id)) alias.pattern = structuredClone(edited.pattern)
	}

	const files = await plugin.exportFiles({
		bundles: [{ id: bundle.id, declarations: bundle.declarations }],
		messages: bundle.messages.map((message) => ({
			id: message.id,
			bundleId: message.bundle_id,
			locale: message.locale,
			selectors: message.selectors,
		})),
		variants: bundle.messages.flatMap((message) =>
			message.variants.map((variant) => ({
				id: variant.id,
				messageId: variant.message_id,
				matches: variant.matches,
				pattern: variant.pattern,
			}))
		),
		settings: structuredClone(settings),
	})
	const imported = await plugin.importFiles({
		files: files.map((file) => ({ ...file, toBeImportedFilesMetadata: file.metadata })),
		settings: structuredClone(settings),
	})
	const parsedBundle = imported.bundles.find((entry) => entry.id === bundle.id)
	if (!parsedBundle)
		throw new Error(
			`The resource plugin cannot represent translation ID "${bundle.id}" without changing its identity.`
		)
	const uniqueMessages = new Map<string, (typeof imported.messages)[number]>()
	for (const message of imported.messages)
		if (message.bundleId === bundle.id) {
			uniqueMessages.set(message.id ?? message.locale, message)
		}
	const messages = [...uniqueMessages.values()].map((message) => {
		const previous = bundle.messages.find(
			(entry) => entry.id === message.id || entry.locale === message.locale
		)
		const id = message.id ?? previous?.id ?? uuid()
		const parsedVariants = imported.variants.filter(
			(variant) =>
				(variant.messageId === message.id && message.id !== undefined) ||
				(variant.messageBundleId === bundle.id && variant.messageLocale === message.locale)
		)
		const uniqueVariants: typeof parsedVariants = []
		for (const variant of parsedVariants) {
			const index = uniqueVariants.findIndex((entry) =>
				variant.id ? entry.id === variant.id : isEqual(entry.matches ?? [], variant.matches ?? [])
			)
			if (index === -1) uniqueVariants.push(variant)
			else uniqueVariants[index] = variant
		}
		const variants = uniqueVariants.map((variant) => {
			const old = previous?.variants.find(
				(entry) => entry.id === variant.id || isEqual(entry.matches, variant.matches ?? [])
			)
			return {
				id: variant.id ?? old?.id ?? uuid(),
				message_id: id,
				matches: variant.matches ?? [],
				pattern: variant.pattern ?? [],
			}
		})
		return {
			id,
			bundle_id: bundle.id,
			locale: message.locale,
			selectors: message.selectors ?? [],
			variants,
		}
	})
	return { id: bundle.id, declarations: parsedBundle.declarations ?? [], messages }
}
