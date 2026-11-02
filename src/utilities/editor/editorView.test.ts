import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { editorView } from "./editorView.js"
import { saveProject } from "../../main.js"
import { saveProjectResources } from "../project/projectResourceSynchronization.js"
import { applyResourceChanges, handleUpdateBundle } from "./helper/handleBundleUpdate.js"
import { createMessage } from "./helper/createMessage.js"
import { selectBundleById } from "../project/selectBundleById.js"
import { msg } from "../messages/msg.js"
import { mutateBundle } from "./helper/mutateBundle.js"
import { deleteVariant } from "./helper/deleteVariant.js"
import { deleteBundleNested } from "./helper/deleteBundleNested.js"

const mocks = vi.hoisted(() => ({
	receiveMessage: undefined as undefined | ((message: unknown) => Promise<void>),
	disposePanel: undefined as undefined | (() => void),
	changeViewState: undefined as
		| undefined
		| ((event: { webviewPanel: { visible: boolean } }) => Promise<void>),
}))

vi.mock("vscode", () => ({
	ViewColumn: { One: 1 },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
	window: {
		showWarningMessage: vi.fn(async () => "Delete"),
		createWebviewPanel: vi.fn(() => ({
			webview: {
				html: "",
				postMessage: vi.fn(),
				onDidReceiveMessage: vi.fn((callback) => {
					mocks.receiveMessage = callback
					return { dispose: vi.fn() }
				}),
			},
			onDidDispose: vi.fn((callback) => {
				mocks.disposePanel = callback
			}),
			onDidChangeViewState: vi.fn((callback) => {
				mocks.changeViewState = callback
			}),
			dispose: vi.fn(),
		})),
	},
}))
vi.mock("../../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_EDITOR_VIEW_CHANGE: { fire: vi.fn() },
		},
	},
}))
vi.mock("../messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("./helper/getUri.js", () => ({ getUri: vi.fn() }))
vi.mock("./helper/getNonce.js", () => ({ getNonce: vi.fn(() => "nonce") }))
vi.mock("./helper/handleBundleUpdate.js", () => ({
	handleUpdateBundle: vi.fn(async () => true),
	applyResourceChanges: vi.fn(async () => true),
}))
vi.mock("../cloud/cloudView.js", () => ({ showCloudPanel: vi.fn() }))
vi.mock("./helper/deleteVariant.js", () => ({ deleteVariant: vi.fn(async () => undefined) }))
vi.mock("./helper/deleteBundleNested.js", () => ({
	deleteBundleNested: vi.fn(async () => undefined),
}))
vi.mock("./helper/createMessage.js", () => ({
	createMessage: vi.fn(async () => undefined),
}))
vi.mock("../project/selectBundleById.js", () => ({
	selectBundleById: vi.fn(async () => ({ id: "welcome", messages: [] })),
}))
vi.mock("../../main.js", () => ({
	saveProject: vi.fn(async () => "saved"),
}))
vi.mock("../project/projectResourceSynchronization.js", () => ({
	saveProjectResources: vi.fn(async () => undefined),
}))

describe("editorView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.receiveMessage = undefined
		mocks.disposePanel = undefined
		mocks.changeViewState = undefined
		vi.mocked(saveProject).mockResolvedValue("saved")
		vi.mocked(selectBundleById).mockResolvedValue({ id: "welcome", messages: [] } as never)
	})

	it("does not export an unchanged project during session disposal", async () => {
		const project = {}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: {
				path: "/workspace/project.inlang",
				project,
				isCurrent: () => false,
			} as any,
		})

		await view.dispose({ persist: true })

		expect(saveProjectResources).not.toHaveBeenCalled()
	})

	it("persists a dirty focused edit during extension shutdown", async () => {
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const lease = {
			path: "/workspace/project.inlang",
			project,
			isCurrent: () => true,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: lease as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		await mocks.receiveMessage?.({
			command: "change",
			change: {
				entity: "variant",
				entityId: "variant-id",
				newData: { id: "variant-id", pattern: [] },
			},
		})

		await view.dispose({ persist: true })

		expect(saveProjectResources).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})

	it("retries a failed blur save during extension shutdown", async () => {
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const lease = {
			path: "/workspace/project.inlang",
			project,
			isCurrent: () => true,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: lease as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "variant-id", newData: { id: "variant-id" } },
		})
		vi.mocked(saveProject).mockResolvedValueOnce("failed")
		await mocks.receiveMessage?.({ command: "persist-edit" })

		await view.dispose({ persist: true })

		expect(saveProjectResources).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})

	it("does not let an older save acknowledge a newer edit", async () => {
		let finishSave!: (status: "saved") => void
		const saving = new Promise<"saved">((resolve) => {
			finishSave = resolve
		})
		vi.mocked(saveProject).mockReturnValueOnce(saving)
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const lease = {
			path: "/workspace/project.inlang",
			project,
			isCurrent: () => true,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: lease as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "first", newData: { id: "first" } },
		})
		const firstPersist = mocks.receiveMessage?.({ command: "persist-edit" })
		await vi.waitFor(() => expect(saveProject).toHaveBeenCalledOnce())
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "second", newData: { id: "second" } },
		})
		finishSave("saved")
		await firstPersist

		await view.dispose({ persist: true })

		expect(saveProjectResources).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})

	it("waits for a matching structural update before acknowledging its revision", async () => {
		let finishSecondUpdate!: () => void
		const secondUpdate = new Promise<void>((resolve) => {
			finishSecondUpdate = resolve
		})
		let finishBundleQuery!: (value: { id: string; messages: never[] }) => void
		const bundleQuery = new Promise<{ id: string; messages: never[] }>((resolve) => {
			finishBundleQuery = resolve
		})
		vi.mocked(handleUpdateBundle).mockResolvedValueOnce(true)
		vi.mocked(createMessage).mockReturnValueOnce(secondUpdate)
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const runTask = vi.fn(async <T>(task: () => Promise<T>) => ({
			status: "completed" as const,
			value: await task(),
		}))
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: {
				path: "/workspace/project.inlang",
				project,
				isCurrent: () => true,
				runTask,
			} as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		vi.mocked(selectBundleById).mockReturnValueOnce(bundleQuery as never)
		const firstChange = mocks.receiveMessage?.({
			command: "change",
			persist: true,
			change: { entity: "variant", entityId: "first", newData: { id: "first" } },
		})
		await vi.waitFor(() => expect(selectBundleById).toHaveBeenCalledTimes(2))
		const secondChange = mocks.receiveMessage?.({
			command: "create-message",
			message: { id: "second", bundle_id: "welcome" },
		})
		expect(runTask).toHaveBeenCalledTimes(4)

		finishBundleQuery({ id: "welcome", messages: [] })
		await Promise.resolve()
		expect(saveProject).not.toHaveBeenCalled()

		finishSecondUpdate()
		await Promise.all([firstChange, secondChange])
		expect(saveProject).toHaveBeenCalledOnce()
	})
	function createTestView() {
		const project = { db: {}, settings: { get: vi.fn(async () => ({ locales: [] })) } }
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: {
				path: "/workspace/project.inlang",
				project,
				isCurrent: () => true,
				runTask: async <T>(task: () => Promise<T>) => ({
					status: "completed",
					value: await task(),
				}),
			} as any,
		})
		return { view, project }
	}

	it("waits for frontend readiness before sending its initial state", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		expect(mocks.receiveMessage).toBeTypeOf("function")
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
		await mocks.receiveMessage?.({ command: "ready" })
		expect(panel.webview.postMessage).toHaveBeenCalledOnce()
		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			command: "change",
			data: { bundle: { id: "welcome", messages: [] }, settings: { locales: [] } },
		})
	})

	it("does not send initial state after its panel closes during loading", async () => {
		let finishQuery!: (value: any) => void
		vi.mocked(selectBundleById).mockReturnValueOnce(
			new Promise((resolve) => {
				finishQuery = resolve
			}) as never
		)
		const { view } = createTestView()
		await view.createOrShowPanel()
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		const loading = mocks.receiveMessage?.({ command: "ready" })
		await vi.waitFor(() => expect(finishQuery).toBeTypeOf("function"))
		mocks.disposePanel?.()
		finishQuery({ id: "welcome", messages: [] })
		await expect(loading).resolves.toBeUndefined()
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
	})

	it("discards a visibility snapshot when an edit arrives while it loads", async () => {
		const { view, project } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		panel.webview.postMessage.mockClear()
		let finishSettings!: (value: any) => void
		project.settings.get.mockReturnValueOnce(
			new Promise((resolve) => {
				finishSettings = resolve
			})
		)
		const refreshing = mocks.changeViewState?.({ webviewPanel: { visible: true } })
		await vi.waitFor(() => expect(finishSettings).toBeTypeOf("function"))
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "edited", newData: { id: "edited" } },
		})
		finishSettings({ locales: [] })
		await refreshing
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
	})

	it("does not let an older refresh replace a newer refresh", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		panel.webview.postMessage.mockClear()
		let finishQuery!: (value: any) => void
		vi.mocked(selectBundleById).mockReturnValueOnce(
			new Promise((resolve) => {
				finishQuery = resolve
			}) as never
		)
		const older = mocks.changeViewState?.({ webviewPanel: { visible: true } })
		await vi.waitFor(() => expect(finishQuery).toBeTypeOf("function"))
		await mocks.changeViewState?.({ webviewPanel: { visible: true } })
		finishQuery({ id: "stale", messages: [] })
		await older
		expect(panel.webview.postMessage).toHaveBeenCalledOnce()
		expect(panel.webview.postMessage.mock.calls[0][0].data.bundle.id).toBe("welcome")
	})

	it("reports an unexpected mutation failure and accepts the next edit", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
		vi.mocked(handleUpdateBundle).mockRejectedValueOnce(new Error("Invalid pattern"))
		const change = {
			command: "change",
			change: { entity: "variant", entityId: "edited", newData: { id: "edited" } },
		}
		await expect(mocks.receiveMessage?.(change)).resolves.toBeUndefined()
		expect(msg).toHaveBeenCalledExactlyOnceWith(
			"Failed to update editor. Error: Invalid pattern",
			"error"
		)
		await mocks.receiveMessage?.({ command: "persist-edit" })
		expect(saveProject).not.toHaveBeenCalled()

		await mocks.receiveMessage?.(change)
		await mocks.receiveMessage?.({ command: "persist-edit" })
		expect(handleUpdateBundle).toHaveBeenCalledTimes(2)
		expect(saveProject).toHaveBeenCalledOnce()
		await view.dispose({ persist: true })
		expect(saveProjectResources).not.toHaveBeenCalled()
		errorLog.mockRestore()
	})

	it("does not persist or refresh an edit rejected by its resource parser", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		panel.webview.postMessage.mockClear()
		vi.mocked(handleUpdateBundle).mockResolvedValueOnce(false)
		await mocks.receiveMessage?.({
			command: "change",
			persist: true,
			change: { entity: "variant", entityId: "edited", newData: { id: "edited" } },
		})
		await mocks.receiveMessage?.({ command: "persist-edit" })
		await view.dispose({ persist: true })
		expect(saveProject).not.toHaveBeenCalled()
		expect(saveProjectResources).not.toHaveBeenCalled()
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
		expect(msg).not.toHaveBeenCalled()
		expect(panel.dispose).toHaveBeenCalledOnce()
	})

	it("releases its panel and listener after a failed mutation", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
		vi.mocked(handleUpdateBundle).mockRejectedValueOnce(new Error("Invalid pattern"))
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "edited", newData: { id: "edited" } },
		})
		await expect(view.dispose({ persist: true })).resolves.toBeUndefined()
		expect(panel.dispose).toHaveBeenCalledOnce()
		expect(panel.webview.onDidReceiveMessage.mock.results[0].value.dispose).toHaveBeenCalledOnce()
		expect(saveProjectResources).not.toHaveBeenCalled()
		errorLog.mockRestore()
	})

	it("releases its panel and listener even when shutdown export fails", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "edited", newData: { id: "edited" } },
		})
		vi.mocked(saveProjectResources).mockRejectedValueOnce(new Error("Disk full"))
		await expect(view.dispose({ persist: true })).rejects.toThrow("Disk full")
		expect(panel.dispose).toHaveBeenCalledOnce()
		expect(panel.webview.onDidReceiveMessage.mock.results[0].value.dispose).toHaveBeenCalledOnce()
	})

	it.each([
		{
			name: "new locale creation",
			command: { command: "create-message", message: { id: "new", bundle_id: "welcome" } },
			helper: createMessage,
		},
		{
			name: "variant deletion",
			command: { command: "delete-variant", id: "existing" },
			helper: deleteVariant,
		},
		{
			name: "bundle deletion",
			command: { command: "delete-bundle", id: "welcome" },
			helper: deleteBundleNested,
		},
	])("serializes $name behind another panel's bundle edit", async ({ command, helper }) => {
		const { view, project } = createTestView()
		await view.createOrShowPanel()
		vi.mocked(selectBundleById).mockResolvedValue({
			id: "welcome",
			messages: [{ variants: [{ id: "existing" }] }],
		} as never)
		let release!: () => void
		let started!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const editing = new Promise<void>((resolve) => {
			started = resolve
		})
		const otherPanel = mutateBundle(project as never, "welcome", async () => {
			started()
			await gate
		})
		await editing
		const structural = mocks.receiveMessage?.(command)
		await new Promise((resolve) => setImmediate(resolve))
		expect(helper).not.toHaveBeenCalled()
		release()
		await Promise.all([otherPanel, structural])
		expect(helper).toHaveBeenCalledOnce()
		expect(saveProject).toHaveBeenCalledOnce()
		await view.dispose()
	})

	it("ignores a stale variant deletion after an earlier bundle edit removed it", async () => {
		const { view, project } = createTestView()
		await view.createOrShowPanel()
		let release!: () => void
		let started!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const editing = new Promise<void>((resolve) => {
			started = resolve
		})
		const otherPanel = mutateBundle(project as never, "welcome", async () => {
			started()
			await gate
		})
		await editing
		const structural = mocks.receiveMessage?.({ command: "delete-variant", id: "obsolete" })
		release()
		await Promise.all([otherPanel, structural])
		expect(deleteVariant).not.toHaveBeenCalled()
		expect(saveProject).not.toHaveBeenCalled()
		await view.dispose({ persist: true })
		expect(saveProjectResources).not.toHaveBeenCalled()
	})

	it("does not save when canonical variant deletion is rejected", async () => {
		const { view, project } = createTestView()
		await view.createOrShowPanel()
		vi.mocked(selectBundleById).mockResolvedValue({
			id: "welcome",
			messages: [{ variants: [{ id: "existing" }] }],
		} as never)
		vi.mocked(deleteVariant).mockResolvedValueOnce(false)
		await mocks.receiveMessage?.({ command: "delete-variant", id: "existing" })
		expect(deleteVariant).toHaveBeenCalledExactlyOnceWith({ project, variantId: "existing" })
		await view.dispose({ persist: true })
		expect(saveProject).not.toHaveBeenCalled()
		expect(saveProjectResources).not.toHaveBeenCalled()
	})

	it("passes native AST edit intent through to the resource mutation", async () => {
		const { view, project } = createTestView()
		await view.createOrShowPanel()
		const changes = [{ entity: "variant", entityId: "edited", newData: { id: "edited" } }]
		const patternEdits = ["edited"]
		await mocks.receiveMessage?.({ command: "apply-changes", changes, patternEdits, persist: true })
		expect(applyResourceChanges).toHaveBeenCalledExactlyOnceWith({
			project,
			bundleId: "welcome",
			changes,
			patternEdits,
		})
		expect(saveProject).toHaveBeenCalledOnce()
	})

	it("resets rejected editor batches without saving and accepts the next batch", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({ command: "ready" })
		const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)!.value
		panel.webview.postMessage.mockClear()
		vi.mocked(applyResourceChanges).mockRejectedValueOnce(new Error("Invalid markup"))
		const change = {
			command: "apply-changes",
			changes: [{ entity: "variant", entityId: "edited" }],
			persist: true,
		}
		await mocks.receiveMessage?.(change)
		expect(msg).toHaveBeenCalledExactlyOnceWith(
			"Couldn't save the edit. Error: Invalid markup",
			"error"
		)
		expect(panel.webview.postMessage.mock.calls[0][0]).toMatchObject({ reset: true })
		expect(saveProject).not.toHaveBeenCalled()
		await mocks.receiveMessage?.(change)
		expect(saveProject).toHaveBeenCalledOnce()
	})

	it("keeps a bundle when deletion is cancelled", async () => {
		const { view } = createTestView()
		await view.createOrShowPanel()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never)
		await mocks.receiveMessage?.({ command: "delete-bundle", id: "welcome" })
		expect(deleteBundleNested).not.toHaveBeenCalled()
		expect(saveProject).not.toHaveBeenCalled()
	})
})
