import path from "node:path"
import crypto from "node:crypto"
import type fs from "node:fs"
import * as nodeFs from "node:fs"
import nodeFsPromises from "node:fs/promises"
import * as vscode from "vscode"
import { loadProjectFromDirectory, saveProjectToDirectory, type InlangProject } from "@inlang/sdk"
import { deactivateBeforeClose, type ProjectSession } from "./projectSession.js"
import { createFileSystemMapper, type FileSystem } from "../fs/createFileSystemMapper.js"

const DEBOUNCE_MS = 150
const MISSING_RESOURCE = Symbol("missing resource")
type JsonObject = Record<string, unknown>
type DottedMessageKeySnapshot = {
	messageFilePath: string
	keys: Map<string, { hadNestedPath: boolean }>
}

type ResourceLoadSnapshot = ReadonlyMap<string, string | typeof MISSING_RESOURCE>

type ResourceWriteState = {
	activeWrites: number
	revision: number
	refreshers: Set<() => Promise<void>>
	preflightChecks: Set<() => Promise<void>>
	trackedPaths: Map<string, number>
	expectedFingerprints: Map<string, string | typeof MISSING_RESOURCE>
	writeQueue: Promise<void>
	release?: Promise<void>
	releaseWrite?: () => void
}

type FileSystemMutation =
	| {
			type: "write"
			path: string
			data: Parameters<FileSystem["writeFile"]>[1]
			options: Parameters<FileSystem["writeFile"]>[2]
	  }
	| { type: "delete"; path: string; recursive: boolean }

type PluginResourceDescriptor = {
	pluginKey: string
	path: string
	absolutePath: string
	locale: string
	metadata?: Record<string, unknown>
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown) {
	try {
		onError?.(error)
	} catch (reportingError) {
		console.error("Failed to report plugin-resource watcher error", reportingError)
	}
}

async function discoverPluginResourceDescriptors(args: {
	session: ProjectSession<InlangProject>
	onError?(error: unknown): void
}): Promise<PluginResourceDescriptor[]> {
	const settings = await args.session.project.settings.get()
	const plugins = await args.session.project.plugins.get()
	const projectDirectory = path.dirname(args.session.path)
	const descriptors: PluginResourceDescriptor[] = []

	for (const plugin of plugins) {
		if (!plugin.toBeImportedFiles || !plugin.importFiles) continue
		try {
			for (const descriptor of await plugin.toBeImportedFiles({ settings })) {
				descriptors.push({
					pluginKey: plugin.key,
					path: descriptor.path,
					absolutePath: path.normalize(
						path.isAbsolute(descriptor.path)
							? descriptor.path
							: path.resolve(projectDirectory, descriptor.path)
					),
					locale: descriptor.locale,
					metadata: descriptor.metadata,
				})
			}
		} catch (error) {
			reportError(args.onError, error)
		}
	}

	return descriptors
}

function escapeGlobFilename(filename: string) {
	return filename.replace(/[\[\]*?{}]/g, (character) => {
		if (character === "[") return "[[]"
		if (character === "]") return "[]]"
		return `[${character}]`
	})
}

function isMissingFile(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function fingerprint(filePath: string) {
	const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
	return fingerprintContent(content)
}

function fingerprintContent(content: string | NodeJS.ArrayBufferView) {
	return crypto.createHash("sha256").update(content).digest("hex")
}

function fingerprintWrite(mutation: Extract<FileSystemMutation, { type: "write" }>) {
	const hash = crypto.createHash("sha256")
	if (typeof mutation.data === "string") {
		const encoding =
			typeof mutation.options === "string"
				? mutation.options
				: (mutation.options?.encoding ?? "utf8")
		return hash.update(mutation.data, encoding).digest("hex")
	}
	if (ArrayBuffer.isView(mutation.data)) return hash.update(mutation.data).digest("hex")
	return undefined
}

function isPathWithin(parentPath: string, filePath: string) {
	const relativePath = path.relative(parentPath, filePath)
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath))
	)
}

function observeResourceLoads(fileSystem: typeof fs): {
	fs: typeof fs
	snapshot: ResourceLoadSnapshot
} {
	const snapshot = new Map<string, string | typeof MISSING_RESOURCE>()
	const trackedReadFile = async (...args: unknown[]) => {
		const filePath = path.normalize(String(args[0]))
		try {
			const content = await Reflect.apply(fileSystem.promises.readFile, fileSystem.promises, args)
			if (!snapshot.has(filePath)) snapshot.set(filePath, fingerprintContent(content))
			return content
		} catch (error) {
			if (isMissingFile(error) && !snapshot.has(filePath)) {
				snapshot.set(filePath, MISSING_RESOURCE)
			}
			throw error
		}
	}
	const promises = new Proxy(fileSystem.promises, {
		get(target, property, receiver) {
			if (property === "readFile") return trackedReadFile
			return Reflect.get(target, property, receiver)
		},
	})
	const trackedFileSystem = new Proxy(fileSystem, {
		get(target, property, receiver) {
			if (property === "promises") return promises
			return Reflect.get(target, property, receiver)
		},
	})
	return { fs: trackedFileSystem, snapshot }
}

function resourceWriteState(project: object, resourceWrites: WeakMap<object, ResourceWriteState>) {
	let state = resourceWrites.get(project)
	if (!state) {
		state = {
			activeWrites: 0,
			revision: 0,
			refreshers: new Set(),
			preflightChecks: new Set(),
			trackedPaths: new Map(),
			expectedFingerprints: new Map(),
			writeQueue: Promise.resolve(),
		}
		resourceWrites.set(project, state)
	}
	return state
}

async function runWithResourceWrite<T>(
	project: object,
	writeState: (project: object) => ResourceWriteState,
	write: (recordResourceWrite: (mutation: FileSystemMutation) => void) => Promise<T>
) {
	const state = writeState(project)
	const queuedWrite = state.writeQueue.then(async () => {
		for (const preflightCheck of state.preflightChecks) await preflightCheck()
		state.revision += 1
		state.expectedFingerprints.clear()
		state.release = new Promise<void>((resolve) => {
			state.releaseWrite = resolve
		})
		state.activeWrites = 1
		const recordResourceWrite = (mutation: FileSystemMutation) => {
			const normalizedPath = path.normalize(mutation.path)
			if (mutation.type === "write") {
				if (!state.trackedPaths.has(normalizedPath)) return
				const intendedFingerprint = fingerprintWrite(mutation)
				if (intendedFingerprint !== undefined) {
					state.expectedFingerprints.set(normalizedPath, intendedFingerprint)
				}
				return
			}
			for (const trackedPath of state.trackedPaths.keys()) {
				if (
					trackedPath === normalizedPath ||
					(mutation.recursive && isPathWithin(normalizedPath, trackedPath))
				) {
					state.expectedFingerprints.set(trackedPath, MISSING_RESOURCE)
				}
			}
		}
		let succeeded = false
		try {
			const result = await write(recordResourceWrite)
			succeeded = true
			return result
		} finally {
			try {
				if (succeeded) for (const refresh of state.refreshers) await refresh()
			} finally {
				state.activeWrites = 0
				const releaseWrite = state.releaseWrite
				state.release = undefined
				state.releaseWrite = undefined
				releaseWrite?.()
			}
		}
	})
	state.writeQueue = queuedWrite.then(
		() => undefined,
		() => undefined
	)
	return queuedWrite
}

async function watchProjectResources(args: {
	session: ProjectSession<InlangProject>
	loadSnapshot?: ResourceLoadSnapshot
	writeState(project: object): ResourceWriteState
	onError?(error: unknown): void
}): Promise<PluginResourceDescriptor[]> {
	const discovery = await args.session.runTask(() =>
		discoverPluginResourceDescriptors({ session: args.session, onError: args.onError })
	)
	if (discovery.status === "inactive") return []

	const descriptors = discovery.value
	const resourcePaths = [...new Set(descriptors.map((descriptor) => descriptor.absolutePath))]
	const fingerprints = new Map<string, string | typeof MISSING_RESOURCE>()
	const watchers: vscode.FileSystemWatcher[] = []
	const running = new Set<Promise<unknown>>()
	const pendingEvents = new Map<string, "create" | "change" | "delete">()
	const processingPaths = new Set<string>()
	let acceptingEvents = true
	let initializingFingerprints = true
	let changedDuringInitialization = false
	let changedAcrossLoadHandoff = false
	let reconciliationPending = false
	let debounceTimer: NodeJS.Timeout | undefined

	const requestReconciliation = () => {
		debounceTimer = undefined
		if (!acceptingEvents) return
		args.session.requestReconciliation()
	}

	const scheduleReload = () => {
		if (!acceptingEvents) return
		reconciliationPending = true
		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = setTimeout(requestReconciliation, DEBOUNCE_MS)
	}

	const processEvent = async (
		filePath: string,
		event: "create" | "change" | "delete"
	): Promise<void> => {
		if (!acceptingEvents) return
		const writeState = args.writeState(args.session.project)
		const writeRevision = writeState.revision
		if (writeState.activeWrites > 0) {
			await writeState.release
		}
		if (event === "delete") {
			if (fingerprints.get(filePath) === MISSING_RESOURCE) return
			fingerprints.set(filePath, MISSING_RESOURCE)
			scheduleReload()
			return
		}

		try {
			const nextFingerprint = await fingerprint(filePath)
			if (writeState.activeWrites > 0) await writeState.release
			if (writeState.revision !== writeRevision) {
				return processEvent(filePath, event)
			}
			if (!acceptingEvents || fingerprints.get(filePath) === nextFingerprint) return
			fingerprints.set(filePath, nextFingerprint)
			scheduleReload()
		} catch (error) {
			if (writeState.activeWrites > 0) await writeState.release
			if (writeState.revision !== writeRevision) {
				return processEvent(filePath, event)
			}
			if (isMissingFile(error)) {
				if (event === "create" || fingerprints.get(filePath) !== MISSING_RESOURCE) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					scheduleReload()
				}
			} else {
				reportError(args.onError, error)
				scheduleReload()
			}
		}
	}

	const handleEvent = (filePath: string, event: "create" | "change" | "delete") => {
		if (!acceptingEvents) return
		if (initializingFingerprints) {
			changedDuringInitialization = true
			return
		}
		pendingEvents.set(filePath, event)
		if (processingPaths.has(filePath)) return
		processingPaths.add(filePath)
		const execution = args.session.runTask(async () => {
			try {
				while (acceptingEvents) {
					const pendingEvent = pendingEvents.get(filePath)
					if (!pendingEvent) return
					pendingEvents.delete(filePath)
					await processEvent(filePath, pendingEvent)
				}
			} finally {
				processingPaths.delete(filePath)
			}
		})
		running.add(execution)
		void execution.finally(() => running.delete(execution)).catch(() => undefined)
	}

	const writeState = args.writeState(args.session.project)
	const checkResourcesBeforeWrite = async () => {
		if (!acceptingEvents) return
		if (!reconciliationPending) {
			for (const filePath of resourcePaths) {
				let currentFingerprint: string | typeof MISSING_RESOURCE
				try {
					currentFingerprint = await fingerprint(filePath)
				} catch (error) {
					if (!isMissingFile(error)) throw error
					currentFingerprint = MISSING_RESOURCE
				}
				if (fingerprints.get(filePath) === currentFingerprint) continue
				fingerprints.set(filePath, currentFingerprint)
				scheduleReload()
			}
		}
		if (reconciliationPending) {
			throw new ProjectResourcesChangedError()
		}
	}
	const refreshAfterWrite = async () => {
		for (const [filePath, expectedFingerprint] of writeState.expectedFingerprints) {
			if (!fingerprints.has(filePath)) continue
			try {
				const currentFingerprint = await fingerprint(filePath)
				if (currentFingerprint !== expectedFingerprint) {
					fingerprints.set(filePath, currentFingerprint)
					scheduleReload()
					continue
				}
				fingerprints.set(filePath, currentFingerprint)
			} catch (error) {
				if (isMissingFile(error) && expectedFingerprint === MISSING_RESOURCE) {
					fingerprints.set(filePath, MISSING_RESOURCE)
				} else if (isMissingFile(error)) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					scheduleReload()
				} else {
					reportError(args.onError, error)
					scheduleReload()
				}
			}
		}
	}
	writeState.preflightChecks.add(checkResourcesBeforeWrite)
	for (const filePath of resourcePaths) {
		writeState.trackedPaths.set(filePath, (writeState.trackedPaths.get(filePath) ?? 0) + 1)
	}
	writeState.refreshers.add(refreshAfterWrite)

	const controller = deactivateBeforeClose({
		dispose: async () => {
			acceptingEvents = false
			writeState.refreshers.delete(refreshAfterWrite)
			writeState.preflightChecks.delete(checkResourcesBeforeWrite)
			for (const filePath of resourcePaths) {
				const owners = writeState.trackedPaths.get(filePath) ?? 0
				if (owners <= 1) writeState.trackedPaths.delete(filePath)
				else writeState.trackedPaths.set(filePath, owners - 1)
			}
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = undefined
			for (const watcher of watchers) watcher.dispose()
			await Promise.allSettled([...running])
			pendingEvents.clear()
			fingerprints.clear()
		},
	})
	if (!args.session.own(controller)) {
		await controller.dispose()
		return descriptors
	}

	for (const filePath of resourcePaths) {
		try {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(
					path.dirname(filePath),
					escapeGlobFilename(path.basename(filePath))
				)
			)
			watcher.onDidCreate(() => handleEvent(filePath, "create"))
			watcher.onDidChange(() => handleEvent(filePath, "change"))
			watcher.onDidDelete(() => handleEvent(filePath, "delete"))
			watchers.push(watcher)
		} catch (error) {
			reportError(args.onError, error)
		}
	}

	await args.session.runTask(async () => {
		for (const filePath of resourcePaths) {
			try {
				const currentFingerprint = await fingerprint(filePath)
				fingerprints.set(filePath, currentFingerprint)
				const loadedFingerprint = args.loadSnapshot?.get(filePath)
				if (
					args.loadSnapshot &&
					(loadedFingerprint === undefined || loadedFingerprint !== currentFingerprint)
				) {
					changedAcrossLoadHandoff = true
				}
			} catch (error) {
				if (isMissingFile(error)) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					const loadedFingerprint = args.loadSnapshot?.get(filePath)
					if (
						args.loadSnapshot &&
						(loadedFingerprint === undefined || loadedFingerprint !== MISSING_RESOURCE)
					) {
						changedAcrossLoadHandoff = true
					}
				} else {
					reportError(args.onError, error)
					if (args.loadSnapshot) changedAcrossLoadHandoff = true
				}
			}
		}

		if (args.loadSnapshot) {
			for (const filePath of resourcePaths) {
				try {
					const verifiedFingerprint = await fingerprint(filePath)
					if (fingerprints.get(filePath) !== verifiedFingerprint) {
						fingerprints.set(filePath, verifiedFingerprint)
						changedAcrossLoadHandoff = true
					}
				} catch (error) {
					if (isMissingFile(error)) {
						if (fingerprints.get(filePath) !== MISSING_RESOURCE) {
							fingerprints.set(filePath, MISSING_RESOURCE)
							changedAcrossLoadHandoff = true
						}
					} else {
						reportError(args.onError, error)
						changedAcrossLoadHandoff = true
					}
				}
			}
		}
	})
	initializingFingerprints = false
	if (changedDuringInitialization || changedAcrossLoadHandoff) scheduleReload()

	return descriptors
}

export class ProjectResourcesChangedError extends Error {
	constructor() {
		super("Project resources changed outside Sherlock; reload before saving.")
		this.name = "ProjectResourcesChangedError"
	}
}

function observeFileSystemMutations(
	fileSystem: FileSystem,
	onDidMutate: (mutation: FileSystemMutation) => Promise<void> | void
): FileSystem {
	return new Proxy(fileSystem, {
		get(target, property, receiver) {
			if (property === "writeFile") {
				return async (...args: Parameters<FileSystem["writeFile"]>) => {
					await Reflect.apply(target.writeFile, target, args)
					await onDidMutate({
						type: "write",
						path: String(args[0]),
						data: args[1],
						options: args[2],
					})
				}
			}
			if (property === "rmdir" || property === "unlink") {
				return async (...args: unknown[]) => {
					await Reflect.apply(target[property], target, args)
					await onDidMutate({ type: "delete", path: String(args[0]), recursive: false })
				}
			}
			if (property === "copyFile") {
				return async (...args: Parameters<FileSystem["copyFile"]>) => {
					const copiedData = await target.readFile(args[0])
					await Reflect.apply(target.copyFile, target, args)
					await onDidMutate({
						type: "write",
						path: String(args[1]),
						data: copiedData,
						options: undefined,
					})
				}
			}
			if (property === "rm") {
				return async (...args: Parameters<FileSystem["rm"]>) => {
					await Reflect.apply(target.rm, target, args)
					await onDidMutate({
						type: "delete",
						path: String(args[0]),
						recursive: args[1]?.recursive === true,
					})
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
}

export type ProjectResourceSynchronization = {
	load(path: string): Promise<InlangProject>
	watch(
		session: ProjectSession<InlangProject>,
		options?: { onError?(error: unknown): void }
	): Promise<void>
	save(project: InlangProject, path: string): Promise<void>
}

export function createProjectResourceSynchronization(): ProjectResourceSynchronization {
	const resourceLoadSnapshots = new WeakMap<InlangProject, ResourceLoadSnapshot>()
	const resourceWrites = new WeakMap<object, ResourceWriteState>()
	const writeState = (project: object) => resourceWriteState(project, resourceWrites)

	return {
		async load(projectPath) {
			const loadTracker = observeResourceLoads(nodeFs)
			const project = await loadProjectFromDirectory({ path: projectPath, fs: loadTracker.fs })
			resourceLoadSnapshots.set(project, loadTracker.snapshot)
			return project
		},
		async watch(session, options) {
			await watchProjectResources({
				session,
				loadSnapshot: resourceLoadSnapshots.get(session.project),
				writeState,
				onError: options?.onError,
			})
		},
		async save(project, projectPath) {
			await runWithResourceWrite(project, writeState, async (recordResourceWrite) => {
				const dottedKeySnapshots = await snapshotExplicitDottedMessageKeys(project, projectPath)
				const trackedFileSystem = observeFileSystemMutations(nodeFsPromises, recordResourceWrite)
				await saveProjectToDirectory({
					fs: createFileSystemMapper(projectPath, trackedFileSystem),
					project,
					path: projectPath,
				})
				await restoreExplicitDottedMessageKeys(dottedKeySnapshots, trackedFileSystem)
			})
		},
	}
}

export const projectResourceSynchronization = createProjectResourceSynchronization()

export function saveProjectResources(project: InlangProject, path: string) {
	return projectResourceSynchronization.save(project, path)
}

async function snapshotExplicitDottedMessageKeys(
	project: InlangProject,
	projectPath: string
): Promise<DottedMessageKeySnapshot[]> {
	const settings = await project.settings.get()
	const pathPattern = getJsonPathPattern(settings)
	if (!pathPattern) return []

	const snapshots: DottedMessageKeySnapshot[] = []
	for (const locale of settings.locales) {
		const messageFilePath = getMessageFilePath(projectPath, pathPattern, locale)
		const json = await readJsonObject(messageFilePath).catch(() => undefined)
		if (!json) continue

		const keys = new Map<string, { hadNestedPath: boolean }>()
		for (const key of Object.keys(json)) {
			if (key === "$schema" || !key.includes(".")) continue
			keys.set(key, { hadNestedPath: getNestedPath(json, key.split(".")) !== undefined })
		}
		if (keys.size > 0) snapshots.push({ messageFilePath, keys })
	}
	return snapshots
}

async function restoreExplicitDottedMessageKeys(
	snapshots: DottedMessageKeySnapshot[],
	fileSystem: FileSystem
) {
	for (const snapshot of snapshots) {
		const originalContent = await fileSystem
			.readFile(snapshot.messageFilePath, "utf8")
			.catch(() => undefined)
		if (originalContent === undefined) continue

		const json = parseJsonObject(originalContent)
		if (!json) continue

		let changed = false
		for (const [key, savedKey] of snapshot.keys) {
			const exportedValue = getNestedPath(json, key.split("."))
			if (exportedValue === undefined) continue
			if (json[key] !== exportedValue) {
				json[key] = exportedValue
				changed = true
			}
			if (!savedKey.hadNestedPath && deleteNestedPath(json, key.split("."))) changed = true
		}
		if (!changed) continue

		await fileSystem.writeFile(
			snapshot.messageFilePath,
			`${JSON.stringify(json, undefined, detectJsonIndent(originalContent))}${
				originalContent.endsWith("\n") ? "\n" : ""
			}`
		)
	}
}

function getJsonPathPattern(settings: Awaited<ReturnType<InlangProject["settings"]["get"]>>) {
	const pathPattern =
		(settings as any)["plugin.inlang.json"]?.pathPattern ??
		(settings as any)["plugin.inlang.messageFormat"]?.pathPattern
	return typeof pathPattern === "string" ? pathPattern : undefined
}

function getMessageFilePath(projectPath: string, pathPattern: string, locale: string) {
	return path.resolve(
		path.dirname(projectPath),
		pathPattern.replace("{languageTag}", locale).replace("{locale}", locale)
	)
}

async function readJsonObject(filePath: string) {
	return parseJsonObject(await nodeFsPromises.readFile(filePath, "utf8"))
}

function parseJsonObject(content: string | Uint8Array) {
	const json = JSON.parse(content.toString())
	return isJsonObject(json) ? json : undefined
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getNestedPath(json: JsonObject, pathParts: string[]) {
	let current: unknown = json
	for (const part of pathParts) {
		if (!isJsonObject(current) || !(part in current)) return undefined
		current = current[part]
	}
	return current
}

function deleteNestedPath(json: JsonObject, pathParts: string[]) {
	if (pathParts.length < 2) return false
	const parents: Array<{ object: JsonObject; key: string }> = []
	let current: JsonObject = json
	for (const part of pathParts.slice(0, -1)) {
		const next = current[part]
		if (!isJsonObject(next)) return false
		parents.push({ object: current, key: part })
		current = next
	}
	const leafKey = pathParts[pathParts.length - 1]
	if (leafKey === undefined || !(leafKey in current)) return false
	delete current[leafKey]
	for (let index = parents.length - 1; index >= 0; index -= 1) {
		const { object, key } = parents[index]!
		const child = object[key]
		if (!isJsonObject(child) || Object.keys(child).length > 0) break
		delete object[key]
	}
	return true
}

function detectJsonIndent(content: string | Uint8Array) {
	return content.toString().match(/\n(\s+)"/)?.[1] ?? "\t"
}
