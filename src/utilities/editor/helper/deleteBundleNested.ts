import { Kysely } from "kysely"
import { type InlangDatabaseSchema } from "@inlang/sdk"
import { inTransaction } from "./inTransaction.js"

/**
 * Delete a bundle along with its nested messages and variants.
 *
 * Runs in one transaction, so that a failure never leaves a bundle without
 * some of its messages or variants.
 *
 * @param db - The Kysely database instance.
 * @param bundleId - The ID of the bundle to delete.
 */
export const deleteBundleNested = async ({
	db,
	bundleId,
}: {
	db: Kysely<InlangDatabaseSchema>
	bundleId: string
}) => {
	try {
		await inTransaction(db, async (trx) => {
			const messageIds = (
				await trx
					.selectFrom("inlang_message")
					.select("inlang_message.id")
					.where("inlang_message.bundle_id", "=", bundleId)
					.execute()
			).map((message) => message.id)

			// Step 1: Delete variants associated with the messages of the bundle
			if (messageIds.length > 0) {
				await trx
					.deleteFrom("inlang_variant")
					.where("inlang_variant.message_id", "in", messageIds)
					.execute()
			}

			// Step 2: Delete messages associated with the bundle
			await trx
				.deleteFrom("inlang_message")
				.where("inlang_message.bundle_id", "=", bundleId)
				.execute()

			// Step 3: Delete the bundle itself
			await trx.deleteFrom("inlang_bundle").where("inlang_bundle.id", "=", bundleId).execute()
		})
	} catch (error) {
		console.error("Failed to delete bundle", error)
	}
}
