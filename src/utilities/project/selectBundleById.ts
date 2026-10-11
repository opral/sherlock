import { selectBundleNested, type BundleNested, type InlangProject } from "@inlang/sdk"

export function selectBundleById(
	project: InlangProject,
	bundleId: string
): Promise<BundleNested | undefined> {
	return selectBundleNested(project.db).where("inlang_bundle.id", "=", bundleId).executeTakeFirst()
}
