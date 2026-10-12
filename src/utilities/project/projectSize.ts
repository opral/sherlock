import type { InlangProject } from "@inlang/sdk"

/**
 * How large a project is, as two counts. Used by telemetry: nothing about the content (keys,
 * texts, paths) leaves this function.
 *
 * - `messageCount`: the number of bundles, i.e. messages as Fink and Parrot count them (one key
 *   in all locales). Counted by the database, the bundles are not loaded.
 * - `languageCount`: the number of locales in the project settings.
 */
export async function getProjectSize(project: InlangProject) {
	const row = await project.db
		.selectFrom("inlang_bundle")
		.select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
		.executeTakeFirst()
	const settings = await project.settings.get()
	return {
		messageCount: Number(row?.count ?? 0),
		languageCount: settings.locales.length,
	}
}
