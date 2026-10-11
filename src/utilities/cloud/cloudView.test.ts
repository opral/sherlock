import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	let onMessage: ((message: unknown) => Promise<void>) | undefined
	const terminal = { show: vi.fn(), sendText: vi.fn() }
	return {
		terminal,
		send: (message: unknown) => onMessage!(message),
		panel: {
			reveal: vi.fn(),
			onDidDispose: vi.fn(),
			webview: {
				html: "",
				cspSource: "vscode-webview:",
				onDidReceiveMessage: vi.fn((listener) => {
					onMessage = listener
				}),
			},
		},
	}
})

vi.mock("vscode", () => ({
	window: {
		createWebviewPanel: vi.fn(() => mocks.panel),
		createTerminal: vi.fn(() => mocks.terminal),
		setStatusBarMessage: vi.fn(),
	},
	env: { openExternal: vi.fn(async () => true), clipboard: { writeText: vi.fn() } },
	Uri: { parse: (value: string) => ({ toString: () => value }), file: (value: string) => value },
	ViewColumn: { Active: -1 },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
}))

vi.mock("../project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({
		activeProject: () => ({ path: "/workspace/apps/web/project.inlang" }),
	}),
}))

const vscode = await import("vscode")
const { showCloudPanel } = await import("./cloudView.js")

describe("cloud panel", () => {
	beforeEach(() => vi.clearAllMocks())

	it("lists the cloud features and the CLI command of the active project", () => {
		showCloudPanel({ source: "command" })
		const html = mocks.panel.webview.html
		expect(html).toContain("inlang Cloud")
		expect(html).toContain("AI translation")
		expect(html).toContain("Smart message keys")
		expect(html).toContain("npx @inlang/cli machine translate --project ./apps/web/project.inlang")
	})

	it("opens the interest form with Sherlock pre-selected", async () => {
		showCloudPanel({ source: "editor" })
		await mocks.send({ command: "open-form" })
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1)
		const url = String(vi.mocked(vscode.env.openExternal).mock.calls[0]![0])
		expect(url).toContain("entry.14901479=Sherlock")
	})

	it("types the CLI command into a terminal without running it", async () => {
		showCloudPanel({ source: "command" })
		await mocks.send({ command: "open-terminal" })
		expect(mocks.terminal.sendText).toHaveBeenCalledWith(
			"npx @inlang/cli machine translate --project ./apps/web/project.inlang",
			false
		)
	})
})
