import { beforeEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"
import { editorView } from "../utilities/editor/editorView.js"
import { capture } from "../services/telemetry/index.js"
import { createOpenEditorViewCallback, openEditorViewCommand } from "./openEditorView.js"

vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
}))

vi.mock("../utilities/editor/editorView.js", () => ({
	editorView: vi.fn(),
}))

vi.mock("../services/telemetry/index.js", () => ({
	capture: vi.fn(),
}))

describe("Open Editor command", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens the requested bundle without exporting it when the session retires", async () => {
		const extensionUri = { fsPath: "/extension" } as vscode.Uri
		const editor = {
			createOrShowPanel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		}
		const lease = {
			own: vi.fn((_resource: { dispose(): Promise<void> }) => true),
		}
		vi.mocked(editorView).mockReturnValue(editor as never)
		const callback = createOpenEditorViewCallback({
			extensionUri,
			activeProject: () => lease as never,
		})

		await callback({ bundleId: "welcome" })

		expect(openEditorViewCommand.command).toBe("sherlock.openEditorView")
		expect(editorView).toHaveBeenCalledWith({
			extensionUri,
			lease,
			initialBundleId: "welcome",
		})
		expect(lease.own).toHaveBeenCalledOnce()
		const ownedResource = lease.own.mock.calls[0]?.[0]
		await ownedResource?.dispose()
		expect(editor.dispose).toHaveBeenCalledWith()
		expect(editor.createOrShowPanel).toHaveBeenCalledOnce()
		expect(capture).toHaveBeenCalledWith({
			event: "IDE-EXTENSION Editor View opened",
			properties: { bundleId: "welcome" },
		})
	})

	it("reveals the open editor of a bundle instead of opening a second one", async () => {
		const editor = {
			createOrShowPanel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
			isDisposed: vi.fn(() => false),
		}
		const lease = { path: "/workspace/reuse.inlang", own: vi.fn(() => true) }
		vi.mocked(editorView).mockReturnValue(editor as never)
		const callback = createOpenEditorViewCallback({
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			activeProject: () => lease as never,
		})

		await callback({ bundleId: "reuse" })
		await callback({ bundleId: "reuse" })
		expect(editorView).toHaveBeenCalledOnce()
		expect(editor.createOrShowPanel).toHaveBeenCalledTimes(2)

		// a closed editor is opened again
		editor.isDisposed.mockReturnValue(true)
		await callback({ bundleId: "reuse" })
		expect(editorView).toHaveBeenCalledTimes(2)
	})

	it("does nothing when there is no active project", async () => {
		const callback = createOpenEditorViewCallback({
			extensionUri: { fsPath: "/extension" } as vscode.Uri,
			activeProject: () => undefined,
		})

		await expect(callback({ bundleId: "welcome" })).resolves.toBeUndefined()

		expect(editorView).not.toHaveBeenCalled()
		expect(capture).not.toHaveBeenCalled()
	})

	it("exports a focused editor when the extension shuts down", async () => {
		const extensionUri = { fsPath: "/extension" } as vscode.Uri
		const editor = {
			createOrShowPanel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		}
		const lease = {
			own: vi.fn(
				(_resource: { dispose(reason?: "replacement" | "shutdown"): Promise<void> }) => true
			),
		}
		vi.mocked(editorView).mockReturnValue(editor as never)
		const callback = createOpenEditorViewCallback({
			extensionUri,
			activeProject: () => lease as never,
		})

		await callback({ bundleId: "welcome" })

		const ownedResource = lease.own.mock.calls[0]?.[0]
		await ownedResource?.dispose("shutdown")

		expect(editor.dispose).toHaveBeenCalledWith({ persist: true })
	})
})
