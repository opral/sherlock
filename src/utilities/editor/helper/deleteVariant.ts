import type { InlangProject, InlangDatabaseSchema } from "@inlang/sdk"
import type { Kysely } from "kysely"
import { CONFIGURATION } from "../../../configuration.js"
import { msg } from "../../messages/msg.js"
import { selectBundleById } from "../../project/selectBundleById.js"
import { normalizeBundle, storageAliases } from "./normalizeBundle.js"
import { writeBundle } from "./writeBundle.js"

/** Delete the source entry and all its model aliases. The caller owns the bundle mutation lock. */
export const deleteVariant = async (
	args:
		| { project: InlangProject; variantId: string }
		| { db: Kysely<InlangDatabaseSchema>; variantId: string }
) => {
	const { variantId } = args
	try {
		if (!("project" in args)) {
			await args.db.deleteFrom("inlang_variant").where("id", "=", variantId).execute()
			CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
			CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()
			return true
		}
		const { project } = args
		const parent = await project.db
			.selectFrom("inlang_variant")
			.innerJoin("inlang_message", "inlang_message.id", "inlang_variant.message_id")
			.select("inlang_message.bundle_id")
			.where("inlang_variant.id", "=", variantId)
			.executeTakeFirst()
		if (!parent) return false
		const bundle = await selectBundleById(project, parent.bundle_id)
		if (!bundle) return false
		const aliases = await storageAliases(project, bundle, variantId)
		for (const message of bundle.messages)
			message.variants = message.variants.filter((variant) => !aliases.has(variant.id))
		// A locale without translations should offer the editor's Add locale action.
		bundle.messages = bundle.messages.filter((message) => message.variants.length > 0)
		const canonical = bundle.messages.length
			? await normalizeBundle(project, bundle)
			: { ...bundle, declarations: [] }
		await writeBundle(project.db, canonical)
		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()
		return true
	} catch (error) {
		console.error("Failed to delete variant", error)
		msg(`Failed to delete variant. ${String(error)}`, "error")
		return false
	}
}
