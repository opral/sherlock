import path from "node:path"
import {
	selectBundleNested,
	type BundleNested,
	type InlangProject,
	type ProjectSettings,
} from "@inlang/sdk"
import { unsupportedPatternTypes } from "../messages/pattern.js"

function resourcePath(settings: ProjectSettings, bundleId: string, locale: string) {
	for (const config of Object.values(settings)) {
		if (!config || typeof config !== "object" || !("pathPattern" in config)) continue
		const pattern = config.pathPattern
		const candidate = typeof pattern === "string" ? pattern : pattern?.[bundleId.split(":")[0]!]
		if (typeof candidate === "string")
			return candidate.replace(/\{(?:locale|languageTag)\}/g, locale)
	}
	return undefined
}

/** One diagnostic per affected variant, independent of how many times a view renders it. */
export function collectPatternErrors(
	bundles: BundleNested[],
	settings: ProjectSettings,
	projectPath: string
): Error[] {
	const errors: Error[] = []
	for (const bundle of bundles)
		for (const message of bundle.messages)
			for (const variant of message.variants) {
				const unsupported = unsupportedPatternTypes(variant.pattern)
				if (unsupported.length === 0) continue
				const source = resourcePath(settings, bundle.id, message.locale)
				const location = source ? ` in ${path.resolve(path.dirname(projectPath), source)}` : ""
				const error = new Error(
					`Translation "${bundle.id}" (${message.locale}, variant ${variant.id})${location} contains unsupported pattern types: ${unsupported.join(", ")}.`
				)
				error.name = "Unsupported translation pattern"
				errors.push(error)
			}
	return errors
}

export async function getProjectPatternErrors(project: InlangProject, projectPath: string) {
	const [bundles, settings] = await Promise.all([
		selectBundleNested(project.db).execute(),
		project.settings.get(),
	])
	return collectPatternErrors(bundles, settings, projectPath)
}
