import { upsertBundleNested, type BundleNested, type InlangProject } from "@inlang/sdk"
import { mutateBundle } from "./mutateBundle.js"

/** A new ID must not overwrite an existing translation or add a second message for its locale. */
export function createBundle(project: InlangProject, bundle: BundleNested) {
	return mutateBundle(project, bundle.id, async (existing) => {
		if (existing)
			throw new Error(`Translation "${bundle.id}" already exists. Choose a different ID.`)
		await upsertBundleNested(project.db, bundle)
	})
}
