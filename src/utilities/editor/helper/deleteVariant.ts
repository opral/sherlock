import type { InlangProject, InlangDatabaseSchema } from "@inlang/sdk"
import type { Kysely } from "kysely"
import { CONFIGURATION } from "../../../configuration.js"
import { msg } from "../../messages/msg.js"

/** Delete the selected model row. Resource representation belongs to its plugin. */
export const deleteVariant = async (
	args:
		| { project: InlangProject; variantId: string }
		| { db: Kysely<InlangDatabaseSchema>; variantId: string }
) => {
	try {
		const db = "project" in args ? args.project.db : args.db
		const deleted = await db
			.deleteFrom("inlang_variant")
			.where("id", "=", args.variantId)
			.returning("id")
			.execute()
		if (!deleted.length) return false
		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()
		return true
	} catch (error) {
		console.error("Failed to delete variant", error)
		msg(`Failed to delete variant. ${String(error)}`, "error")
		return false
	}
}
