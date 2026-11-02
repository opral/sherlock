import type { BundleNested, InlangProject } from "@inlang/sdk"
import { selectBundleById } from "../../project/selectBundleById.js"

const queues = new WeakMap<InlangProject, Map<string, Promise<void>>>()

/** Serialize edits to one bundle and read its latest graph only after previous edits settle. */
export async function mutateBundle<T>(
	project: InlangProject,
	bundleId: string,
	mutation: (current: BundleNested | undefined) => Promise<T>
): Promise<T> {
	let queue = queues.get(project)
	if (!queue) {
		queue = new Map()
		queues.set(project, queue)
	}
	const previous = queue.get(bundleId) ?? Promise.resolve()
	const operation = previous.then(async () => mutation(await selectBundleById(project, bundleId)))
	const settled = operation.then(
		() => undefined,
		() => undefined
	)
	queue.set(bundleId, settled)
	try {
		return await operation
	} finally {
		if (queue.get(bundleId) === settled) queue.delete(bundleId)
	}
}
