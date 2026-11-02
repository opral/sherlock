import type {
	BundleNested,
	BundleRow,
	InlangDatabaseSchema,
	InlangProject,
	MessageRow,
	Pattern,
	VariantRow,
} from "@inlang/sdk"
import type { ChangeEventDetail } from "@inlang/editor-component"
import { msg } from "../../messages/msg.js"
import type { UpdateBundleMessage } from "../editorView.js"
import type { Kysely } from "kysely"
import { inTransaction } from "./inTransaction.js"
import { mutateBundle } from "./mutateBundle.js"
import { normalizeBundle, storageAliases } from "./normalizeBundle.js"
import { writeBundle } from "./writeBundle.js"
import { deleteBundleNested } from "./deleteBundleNested.js"
import { textToPattern } from "../../messages/pattern.js"
import { isEqual } from "lodash-es"

type Db = Kysely<InlangDatabaseSchema>

/**
 * Writes one change of the editor: an upsert of a bundle, message or variant, or a deletion
 * (a change without `newData`).
 *
 * Only the inlang columns are written: rows read with `selectAll()` carry `lixcol_*` columns,
 * and nested rows carry `messages` / `variants`. Throws on failure.
 */
export async function applyChange(db: Db, change: ChangeEventDetail) {
	if (!change.entityId || !change.entity) {
		throw new Error("No entity or entityId provided")
	}

	if (!change.newData) {
		await deleteEntity(db, change.entity, change.entityId)
		return
	}

	switch (change.entity) {
		case "bundle": {
			const bundle = change.newData as BundleRow
			const values = { declarations: bundle.declarations }
			await db
				.insertInto("inlang_bundle")
				.values({ id: change.entityId, ...values })
				.onConflict((oc) => oc.column("id").doUpdateSet(values))
				.execute()
			return
		}
		case "message": {
			const row = change.newData as MessageRow
			const values = { bundle_id: row.bundle_id, locale: row.locale, selectors: row.selectors }
			await db
				.insertInto("inlang_message")
				.values({ id: change.entityId, ...values })
				.onConflict((oc) => oc.column("id").doUpdateSet(values))
				.execute()
			return
		}
		case "variant": {
			const row = change.newData as VariantRow
			const values = { message_id: row.message_id, matches: row.matches, pattern: row.pattern }
			await db
				.insertInto("inlang_variant")
				.values({ id: change.entityId, ...values })
				.onConflict((oc) => oc.column("id").doUpdateSet(values))
				.execute()
			return
		}
		default:
			throw new Error(`Unknown entity ${String(change.entity)}`)
	}
}

/**
 * Writes the changes of one edit in a single transaction: all of them or none.
 *
 * Variables that a written pattern uses and the bundle doesn't declare yet (a `{count}` typed into
 * a translation) are declared as inputs, in the same transaction.
 */
export async function applyChanges(db: Db, changes: readonly ChangeEventDetail[]) {
	await inTransaction(db, async (trx) => {
		for (const change of changes) await applyChange(trx, change)
		await declareInputVariables(trx, changes)
	})
}

async function declareInputVariables(db: Db, changes: readonly ChangeEventDetail[]) {
	const patterns = changes
		.filter((change) => change.entity === "variant" && change.newData)
		.map((change) => (change.newData as VariantRow).pattern)
	const names = new Set(patterns.flatMap(variableNames))
	if (names.size === 0) return
	const messageIds = [
		...new Set(
			changes
				.filter((change) => change.entity === "variant" && change.newData)
				.map((change) => (change.newData as VariantRow).message_id)
		),
	]
	const bundles = await db
		.selectFrom("inlang_bundle")
		.innerJoin("inlang_message", "inlang_message.bundle_id", "inlang_bundle.id")
		.where("inlang_message.id", "in", messageIds)
		.select(["inlang_bundle.id", "inlang_bundle.declarations"])
		.execute()
	const seen = new Set<string>()
	for (const bundle of bundles) {
		if (seen.has(bundle.id)) continue
		seen.add(bundle.id)
		const missing = [...names].filter(
			(name) => !bundle.declarations.some((declaration) => declaration.name === name)
		)
		if (missing.length === 0) continue
		await db
			.updateTable("inlang_bundle")
			.set({
				declarations: [
					...bundle.declarations,
					...missing.map((name) => ({ type: "input-variable" as const, name })),
				],
			})
			.where("inlang_bundle.id", "=", bundle.id)
			.execute()
	}
}

function variableNames(pattern: Pattern): string[] {
	return pattern.flatMap((element) =>
		element.type === "expression" && element.arg.type === "variable-reference"
			? [element.arg.name]
			: []
	)
}

/**
 * Handle the update of a bundle, message or variant that the editor sent, reporting failures.
 *
 * @param message - The message containing the change.
 */
export async function handleUpdateBundle({
	db,
	project,
	message,
}: {
	db?: Db
	project?: InlangProject
	message: UpdateBundleMessage
}) {
	const { change } = message
	try {
		if (project) {
			const bundleId = await findBundleId(project.db, change)
			if (!bundleId) return false
			return await applyResourceChanges({
				project,
				bundleId,
				changes: [change],
				patternTexts:
					message.patternText === undefined
						? undefined
						: { [change.entityId]: message.patternText },
			})
		}
		if (!db) throw new Error("No project or database provided")
		await applyChanges(db, [change])
		return true
	} catch (e) {
		console.error(`Couldn't update ${change.entity}: ${e}`)
		msg(`Couldn't update ${change.entity}. ${String(e)}`, "error")
		return false
	}
}

async function findBundleId(db: Db, change: ChangeEventDetail): Promise<string | undefined> {
	if (change.entity === "bundle") return change.entityId
	if (change.entity === "message") {
		const row = await db
			.selectFrom("inlang_message")
			.select("bundle_id")
			.where("id", "=", change.entityId)
			.executeTakeFirst()
		return row?.bundle_id ?? (change.newData as MessageRow | undefined)?.bundle_id
	}
	const row = await db
		.selectFrom("inlang_variant")
		.innerJoin("inlang_message", "inlang_message.id", "inlang_variant.message_id")
		.select("inlang_message.bundle_id")
		.where("inlang_variant.id", "=", change.entityId)
		.executeTakeFirst()
	if (row) return row.bundle_id
	const messageId = (change.newData as VariantRow | undefined)?.message_id
	if (!messageId) return undefined
	return (
		await db
			.selectFrom("inlang_message")
			.select("bundle_id")
			.where("id", "=", messageId)
			.executeTakeFirst()
	)?.bundle_id
}

/** Apply one editor batch to the latest graph, then parse and write the complete resource context. */
export async function applyResourceChanges(args: {
	project: InlangProject
	bundleId: string
	changes: readonly ChangeEventDetail[]
	patternTexts?: Record<string, string>
	patternEdits?: readonly string[]
}): Promise<boolean> {
	if (!args.changes.length) return false
	return mutateBundle(args.project, args.bundleId, async (current) => {
		if (!current) return false
		let draft: BundleNested | undefined = structuredClone(current)
		const removedAliases = new Set<string>()
		const edited: Array<{ id: string; aliases: Set<string> }> = []
		let canonicalize = false
		for (const change of args.changes) {
			if (!change.entityId || !change.entity) throw new Error("No entity or entityId provided")
			if (!draft) throw new Error("Cannot edit a deleted bundle")
			if (change.entity === "bundle") {
				if (change.entityId !== args.bundleId) throw new Error("The edit belongs to another bundle")
				if (!change.newData) draft = undefined
				// Text edits carry optimistic, derived declarations from the panel's old snapshot.
				// Keep current selector declarations; the resource parser derives inputs for new text.
				else if (!args.patternEdits?.length && !Object.keys(args.patternTexts ?? {}).length)
					draft.declarations = structuredClone((change.newData as BundleRow).declarations)
			} else if (change.entity === "message") {
				const index = draft.messages.findIndex((entry) => entry.id === change.entityId)
				if (!change.newData) {
					if (index >= 0) draft.messages.splice(index, 1)
					canonicalize = true
					continue
				}
				const row = change.newData as MessageRow
				if (row.bundle_id !== args.bundleId)
					throw new Error("The message belongs to another bundle")
				const message = {
					id: change.entityId,
					bundle_id: row.bundle_id,
					locale: row.locale,
					selectors: structuredClone(row.selectors),
					variants: index >= 0 ? draft.messages[index]!.variants : [],
				}
				if (index >= 0) draft.messages[index] = message
				else draft.messages.push(message)
			} else if (change.entity === "variant") {
				const previous = current.messages
					.flatMap((message) => message.variants)
					.find((variant) => variant.id === change.entityId)
				if (!change.newData) {
					canonicalize = true
					const aliases = await storageAliases(args.project, current, change.entityId)
					for (const id of aliases) removedAliases.add(id)
					for (const message of draft.messages)
						message.variants = message.variants.filter((variant) => !aliases.has(variant.id))
					continue
				}
				const row = change.newData as VariantRow
				const source = args.patternTexts?.[change.entityId]
				const patternOnly = source !== undefined || args.patternEdits?.includes(change.entityId)
				const messageId = patternOnly && previous ? previous.message_id : row.message_id
				const message = draft.messages.find((entry) => entry.id === messageId)
				if (!message) throw new Error("The variant's message does not exist in this bundle")
				// A stale text edit must not recreate a variant removed while the field was open.
				if (
					patternOnly &&
					!previous &&
					current.messages.some((entry) => entry.id === row.message_id)
				)
					return false
				const pattern =
					source === undefined ? row.pattern : textToPattern(source, previous?.pattern)
				if (!previous || !isEqual(previous.pattern, pattern)) canonicalize = true
				const variant = {
					id: change.entityId,
					message_id: messageId,
					matches: structuredClone(patternOnly && previous ? previous.matches : row.matches),
					pattern: structuredClone(pattern),
				}
				const index = message.variants.findIndex((entry) => entry.id === change.entityId)
				if (index >= 0) message.variants[index] = variant
				else message.variants.push(variant)
				if (previous && !isEqual(previous.pattern, pattern))
					edited.push({
						id: variant.id,
						aliases: await storageAliases(args.project, current, variant.id),
					})
			} else throw new Error(`Unknown entity ${String(change.entity)}`)
		}
		if (!draft) {
			await deleteBundleNested({ db: args.project.db, bundleId: args.bundleId })
			return true
		}
		for (const message of draft.messages)
			message.variants = message.variants.filter((variant) => !removedAliases.has(variant.id))
		const variants = draft.messages.flatMap((message) => message.variants)
		const aliasPatterns = new Map<string, Pattern>()
		for (const edit of edited) {
			const selected = variants.find((variant) => variant.id === edit.id)
			if (selected)
				for (const id of edit.aliases) {
					const earlier = aliasPatterns.get(id)
					if (earlier && !isEqual(earlier, selected.pattern))
						throw new Error(
							`Conflicting edits target the same resource entry in translation "${args.bundleId}".`
						)
					aliasPatterns.set(id, structuredClone(selected.pattern))
				}
		}
		for (const variant of variants) {
			const pattern = aliasPatterns.get(variant.id)
			if (pattern) variant.pattern = pattern
		}
		// An empty graph has no resource representation to import again.
		let canonical: BundleNested
		try {
			canonical = !canonicalize
				? draft
				: variants.length
					? await normalizeBundle(args.project, draft)
					: { ...draft, declarations: [], messages: [] }
		} catch (cause) {
			const changedVariants = args.changes
				.filter((change) => change.entity === "variant" && change.newData)
				.map((change) => change.entityId)
			const context = draft.messages
				.flatMap((message) =>
					message.variants
						.filter((variant) => changedVariants.includes(variant.id))
						.map((variant) => `${message.locale}, variant ${variant.id}`)
				)
				.join("; ")
			throw new Error(
				`Could not parse translation "${args.bundleId}"${context ? ` (${context})` : ""}: ${String(cause)}`,
				{ cause }
			)
		}
		await writeBundle(args.project.db, canonical)
		return true
	})
}

async function deleteEntity(db: Db, entity: ChangeEventDetail["entity"], id: string) {
	await inTransaction(db, async (trx) => {
		if (entity === "variant") {
			await trx.deleteFrom("inlang_variant").where("inlang_variant.id", "=", id).execute()
		} else if (entity === "message") {
			await trx.deleteFrom("inlang_variant").where("inlang_variant.message_id", "=", id).execute()
			await trx.deleteFrom("inlang_message").where("inlang_message.id", "=", id).execute()
		} else {
			const messageIds = (
				await trx
					.selectFrom("inlang_message")
					.select("inlang_message.id")
					.where("inlang_message.bundle_id", "=", id)
					.execute()
			).map((message) => message.id)
			if (messageIds.length > 0) {
				await trx
					.deleteFrom("inlang_variant")
					.where("inlang_variant.message_id", "in", messageIds)
					.execute()
			}
			await trx.deleteFrom("inlang_message").where("inlang_message.bundle_id", "=", id).execute()
			await trx.deleteFrom("inlang_bundle").where("inlang_bundle.id", "=", id).execute()
		}
	})
}
