import type { BundleRow, InlangDatabaseSchema, MessageRow, Pattern, VariantRow } from "@inlang/sdk"
import type { ChangeEventDetail } from "@inlang/editor-component"
import { msg } from "../../messages/msg.js"
import type { UpdateBundleMessage } from "../editorView.js"
import type { Kysely } from "kysely"
import { inTransaction } from "./inTransaction.js"

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
	message,
}: {
	db: Db
	message: UpdateBundleMessage
}) {
	const { change } = message
	try {
		await applyChanges(db, [change])
	} catch (e) {
		console.error(`Couldn't update ${change.entity}: ${e}`)
		msg(`Couldn't update ${change.entity}. ${String(e)}`, "error")
	}
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
