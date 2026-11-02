import type { BundleNested, InlangDatabaseSchema } from "@inlang/sdk"
import type { Kysely } from "kysely"
import { inTransaction } from "./inTransaction.js"

/** Replace a canonical graph atomically, writing only inlang columns (never lixcol_* metadata). */
export async function writeBundle(db: Kysely<InlangDatabaseSchema>, bundle: BundleNested) {
	await inTransaction(db, async (trx) => {
		await trx
			.insertInto("inlang_bundle")
			.values({ id: bundle.id, declarations: bundle.declarations })
			.onConflict((conflict) =>
				conflict.column("id").doUpdateSet({ declarations: bundle.declarations })
			)
			.execute()
		const messageIds = new Set(bundle.messages.map((message) => message.id))
		const obsoleteIds = (
			await trx
				.selectFrom("inlang_message")
				.select("id")
				.where("bundle_id", "=", bundle.id)
				.execute()
		)
			.filter((message) => !messageIds.has(message.id))
			.map((message) => message.id)
		if (obsoleteIds.length) {
			await trx.deleteFrom("inlang_variant").where("message_id", "in", obsoleteIds).execute()
			await trx.deleteFrom("inlang_message").where("id", "in", obsoleteIds).execute()
		}
		for (const message of bundle.messages) {
			const row = {
				id: message.id,
				bundle_id: bundle.id,
				locale: message.locale,
				selectors: message.selectors,
			}
			await trx
				.insertInto("inlang_message")
				.values(row)
				.onConflict((conflict) => conflict.column("id").doUpdateSet(row))
				.execute()
			const variantIds = new Set(message.variants.map((variant) => variant.id))
			const obsoleteVariantIds = (
				await trx
					.selectFrom("inlang_variant")
					.select("id")
					.where("message_id", "=", message.id)
					.execute()
			)
				.filter((variant) => !variantIds.has(variant.id))
				.map((variant) => variant.id)
			if (obsoleteVariantIds.length)
				await trx.deleteFrom("inlang_variant").where("id", "in", obsoleteVariantIds).execute()
			for (const variant of message.variants) {
				const row = {
					id: variant.id,
					message_id: message.id,
					matches: variant.matches,
					pattern: variant.pattern,
				}
				await trx
					.insertInto("inlang_variant")
					.values(row)
					.onConflict((conflict) => conflict.column("id").doUpdateSet(row))
					.execute()
			}
		}
	})
}
