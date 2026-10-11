import type { BundleRow, InlangDatabaseSchema, MessageRow, VariantRow } from "@inlang/sdk"
import { msg } from "../../messages/msg.js"
import type { UpdateBundleMessage } from "../editorView.js"
import type { Kysely } from "kysely"

/**
 * Handle the update of a bundle, message or variant that the editor sent.
 *
 * Only the inlang columns are written: rows read with `selectAll()` carry
 * `lixcol_*` columns, and nested rows carry `messages` / `variants`.
 *
 * @param message - The message containing the change.
 */
export async function handleUpdateBundle({
	db,
	message,
}: {
	db: Kysely<InlangDatabaseSchema>
	message: UpdateBundleMessage
}) {
	const { change } = message

	try {
		if (!change.entityId || !change.entity) {
			throw new Error("No entity or entityId provided")
		}

		if (!change.newData) {
			// a deleted entity
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
	} catch (e) {
		console.error(`Couldn't update ${change.entity}: ${e}`)
		msg(`Couldn't update ${change.entity}. ${String(e)}`, "error")
	}
}

async function deleteEntity(
	db: Kysely<InlangDatabaseSchema>,
	entity: UpdateBundleMessage["change"]["entity"],
	id: string
) {
	if (entity === "variant") {
		await db.deleteFrom("inlang_variant").where("inlang_variant.id", "=", id).execute()
	} else if (entity === "message") {
		await db.transaction().execute(async (trx) => {
			await trx.deleteFrom("inlang_variant").where("inlang_variant.message_id", "=", id).execute()
			await trx.deleteFrom("inlang_message").where("inlang_message.id", "=", id).execute()
		})
	} else {
		throw new Error(`Deleting a ${entity} is not supported here.`)
	}
}
