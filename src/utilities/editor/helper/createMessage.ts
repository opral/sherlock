/**
 * Create a message with one empty variant.
 *
 * @param db - The Kysely database instance.
 * @param message - The message to create (a database row, as the editor sends it).
 */

import type { InlangDatabaseSchema, NewMessageRow } from "@inlang/sdk"
import type { Kysely } from "kysely"
import { msg } from "../../messages/msg.js"
import { CONFIGURATION } from "../../../configuration.js"

export const createMessage = async ({
	db,
	message,
}: {
	db: Kysely<InlangDatabaseSchema>
	message: NewMessageRow
}) => {
	try {
		await db.transaction().execute(async (trx) => {
			// Only the inlang columns: the webview may send more (e.g. `lixcol_*` or nested `variants`).
			const inserted = await trx
				.insertInto("inlang_message")
				.values({
					id: message.id,
					bundle_id: message.bundle_id,
					locale: message.locale,
					selectors: message.selectors ?? [],
				})
				.returning("id")
				.executeTakeFirstOrThrow()

			// The database creates the variant's id (uuid v7).
			await trx
				.insertInto("inlang_variant")
				.values({
					message_id: inserted.id,
					matches: [],
					pattern: [],
				})
				.execute()
		})
	} catch (error) {
		console.error("Failed to create message", error)
		msg(`Failed to create message. ${String(error)}`, "error")
	}

	CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
	CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()
}
