import path from "node:path"
import type { ExistingFile, ExportFile, InlangProject, ProjectSettings } from "@inlang/sdk"
import type { FileSystem } from "../fs/createFileSystemMapper.js"

const JSON_RESOURCE_PLUGINS = new Set([
	"plugin.inlang.i18next",
	"plugin.inlang.json",
	"plugin.inlang.messageFormat",
])

export type ResourceExportSnapshot = {
	existingFiles: readonly ExistingFile[]
	exportedFiles: readonly ExportFile[]
}

/** Resolve the same export destinations as the SDK, including namespace and per-file overrides. */
function exportDestinations(
	settings: ProjectSettings,
	pluginKey: string,
	file: ExportFile
): string[] {
	const pattern = (settings[pluginKey] as { pathPattern?: unknown } | undefined)?.pathPattern
	const explicit = file.metadata?.pathPattern
	let patterns: string[]
	if (typeof explicit === "string") patterns = [explicit]
	else if (typeof pattern === "string") patterns = [pattern]
	else if (Array.isArray(pattern))
		patterns = pattern.filter((entry): entry is string => typeof entry === "string")
	else if (pattern && typeof pattern === "object") {
		const namespace = file.metadata?.namespace
		const selected =
			typeof namespace === "string" ? (pattern as Record<string, unknown>)[namespace] : undefined
		patterns = [typeof selected === "string" ? selected : file.name]
	} else patterns = [file.name]
	return patterns.map((entry) => entry.replace(/\{(?:languageTag|locale)\}/g, file.locale))
}

/** Clear omitted empty JSON resources only when the SDK confirms their unchanged imported content. */
export async function clearOmittedEmptyJsonResources(args: {
	project: InlangProject
	projectPath: string
	fileSystem: FileSystem
	exports: ReadonlyMap<string, ResourceExportSnapshot>
}) {
	const { project, projectPath, fileSystem } = args
	if (![...args.exports.keys()].some((key) => JSON_RESOURCE_PLUGINS.has(key))) return
	const settings = await project.settings.get()
	// An empty graph after an import failure is not evidence of an intentional deletion.
	if ((await project.errors.get()).length) return
	const exportedPaths = new Set<string>()
	for (const [key, snapshot] of args.exports)
		for (const file of snapshot.exportedFiles)
			for (const destination of exportDestinations(settings, key, file))
				exportedPaths.add(path.resolve(path.dirname(projectPath), destination))
	const [messages, variants] = await Promise.all([
		project.db.selectFrom("inlang_message").select(["id", "bundle_id", "locale"]).execute(),
		project.db.selectFrom("inlang_variant").select("message_id").execute(),
	])
	const populatedMessages = new Set(variants.map((variant) => variant.message_id))
	const candidates = new Map<string, { empty: boolean; file: ExistingFile }>()
	for (const [key, snapshot] of args.exports) {
		if (!JSON_RESOURCE_PLUGINS.has(key)) continue
		for (const file of snapshot.existingFiles) {
			if (file.imported !== true || !file.path.endsWith(".json")) continue
			const resourcePath = path.resolve(path.dirname(projectPath), file.path)
			if (exportedPaths.has(resourcePath)) continue
			const namespace =
				typeof file.metadata?.namespace === "string" ? file.metadata.namespace : undefined
			const populated = messages.some(
				(message) =>
					message.locale === file.locale &&
					populatedMessages.has(message.id) &&
					(namespace === undefined || message.bundle_id.startsWith(`${namespace}:`))
			)
			// Overlapping import descriptors must all be empty before clearing their shared path.
			candidates.set(resourcePath, {
				empty: (candidates.get(resourcePath)?.empty ?? true) && !populated,
				file,
			})
		}
	}
	for (const [resourcePath, candidate] of candidates) {
		if (!candidate.empty) continue
		let bytes: Uint8Array
		try {
			bytes = new Uint8Array(await fileSystem.readFile(resourcePath))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
		// Respect edits made after the SDK read its export input, even without a watcher.
		if (
			bytes.length !== candidate.file.content.length ||
			bytes.some((byte, index) => byte !== candidate.file.content[index])
		)
			continue
		const content = new TextDecoder().decode(bytes)
		try {
			const parsed: unknown = JSON.parse(content)
			if (
				!parsed ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				!Object.keys(parsed).length
			)
				continue
		} catch {
			continue
		}
		const newline = content.includes("\r\n") ? "\r\n" : "\n"
		await fileSystem.writeFile(resourcePath, "{}" + (content.endsWith("\n") ? newline : ""), "utf8")
	}
}
