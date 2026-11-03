import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { linterDiagnostics } from "./linterDiagnostics.js"
import { getExtensionApi } from "../utilities/helper.js"
import { resolveLintRules } from "./lintRuleResolver.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"

const mocks = vi.hoisted(() => ({
	setDiagnostics: vi.fn(),
	projectChangeListener: undefined as (() => void) | undefined,
}))

vi.mock("vscode", () => ({
	window: {
		activeTextEditor: {
			document: { getText: vi.fn(() => "m.hello()"), uri: { path: "/workspace/page.ts" } },
		},
		onDidChangeActiveTextEditor: vi.fn(),
	},
	workspace: { onDidChangeTextDocument: vi.fn() },
	languages: {
		createDiagnosticCollection: vi.fn(() => ({
			set: mocks.setDiagnostics,
			dispose: vi.fn(),
		})),
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown
		) {}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number
		) {}
	},
	Diagnostic: class {
		constructor(
			public range: unknown,
			public message: string,
			public severity: unknown
		) {}
	},
}))

vi.mock("../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_PROJECT_CHANGE: {
				event: vi.fn((listener: () => void) => {
					mocks.projectChangeListener = listener
					return { dispose: vi.fn() }
				}),
			},
		},
	},
}))

vi.mock("../utilities/helper.js", () => ({
	getExtensionApi: vi.fn(async () => ({ messageReferenceMatchers: [] })),
}))

vi.mock("./lintRuleResolver.js", () => ({ resolveLintRules: vi.fn(async () => []) }))
vi.mock("../utilities/project/selectBundleById.js", () => ({ selectBundleById: vi.fn() }))
vi.mock("../utilities/utils.js", () => ({ handleError: vi.fn() }))

describe("linterDiagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.projectChangeListener = undefined
		vi.mocked(getExtensionApi)
			.mockReset()
			.mockResolvedValue({ messageReferenceMatchers: [] } as never)
		vi.mocked(resolveLintRules).mockReset().mockResolvedValue([])
		vi.mocked(selectBundleById).mockReset()
		Object.assign(vscode.window, {
			activeTextEditor: {
				document: { getText: () => "m.hello()", uri: { path: "/workspace/page.ts" } },
			},
		})
	})

	it("refreshes exactly once from the coherent project-change signal", async () => {
		await linterDiagnostics({
			subscriptions: [],
			fs: {} as never,
			session: {
				project: {},
				runTask: async <T>(task: () => Promise<T>) => ({
					status: "completed" as const,
					value: await task(),
				}),
			} as never,
		})

		expect(mocks.setDiagnostics).not.toHaveBeenCalled()
		mocks.projectChangeListener?.()
		await vi.waitFor(() => expect(mocks.setDiagnostics).toHaveBeenCalledTimes(1))
	})

	it("does not publish diagnostics computed by an inactive session", async () => {
		await linterDiagnostics({
			subscriptions: [],
			fs: {} as never,
			session: {
				project: {},
				runTask: async <T>(task: () => Promise<T>) => {
					await task()
					return { status: "inactive" as const }
				},
			} as never,
		})

		mocks.projectChangeListener?.()
		await Promise.resolve()
		expect(mocks.setDiagnostics).not.toHaveBeenCalled()
	})

	async function startDiagnostics() {
		const tasks: Promise<unknown>[] = []
		await linterDiagnostics({
			subscriptions: [],
			fs: {} as never,
			session: {
				project: {},
				runTask: <T>(task: () => Promise<T>) => {
					const execution = task().then((value) => ({ status: "completed", value }))
					tasks.push(execution)
					return execution
				},
			} as never,
		})
		return tasks
	}

	it("clears diagnostics without matching or querying references when no lint rules are configured", async () => {
		const matcher = vi.fn(async () =>
			Array.from({ length: 150 }, (_, index) => ({ bundleId: `message-${index}` }))
		)
		vi.mocked(getExtensionApi).mockResolvedValue({ messageReferenceMatchers: [matcher] } as never)
		await startDiagnostics()
		mocks.projectChangeListener?.()
		await vi.waitFor(() => expect(mocks.setDiagnostics).toHaveBeenCalledOnce())
		expect(mocks.setDiagnostics).toHaveBeenCalledWith(
			vscode.window.activeTextEditor!.document.uri,
			[]
		)
		expect(matcher).not.toHaveBeenCalled()
		expect(selectBundleById).not.toHaveBeenCalled()
	})

	it.each(["a newer lint request", "another active editor"])(
		"stops an outdated configured lint loop after %s",
		async (cancellation) => {
			const matcher = vi.fn(async () =>
				Array.from({ length: 150 }, (_, index) => ({ bundleId: `message-${index}` }))
			)
			const ruleFn = vi.fn(async () => [])
			vi.mocked(getExtensionApi).mockResolvedValue({ messageReferenceMatchers: [matcher] } as never)
			vi.mocked(resolveLintRules).mockResolvedValue([{ name: "test", ruleFn }] as never)
			let finishQuery!: (bundle: unknown) => void
			vi.mocked(selectBundleById).mockReturnValueOnce(
				new Promise((resolve) => {
					finishQuery = resolve
				}) as never
			)
			const tasks = await startDiagnostics()
			mocks.projectChangeListener?.()
			await vi.waitFor(() => expect(selectBundleById).toHaveBeenCalledOnce())
			if (cancellation === "a newer lint request") {
				vi.mocked(getExtensionApi).mockResolvedValue({ messageReferenceMatchers: [] } as never)
				mocks.projectChangeListener?.()
				await vi.waitFor(() => expect(mocks.setDiagnostics).toHaveBeenCalledOnce())
			} else {
				Object.assign(vscode.window, {
					activeTextEditor: { document: { getText: () => "", uri: { path: "/workspace/new.ts" } } },
				})
			}
			finishQuery({ id: "message-0" })
			await Promise.all(tasks)
			await Promise.resolve()
			expect(selectBundleById).toHaveBeenCalledOnce()
			expect(ruleFn).not.toHaveBeenCalled()
			expect(mocks.setDiagnostics).toHaveBeenCalledTimes(
				cancellation === "a newer lint request" ? 1 : 0
			)
		}
	)

	it("places each diagnostic at its matched message position", async () => {
		vi.mocked(getExtensionApi).mockResolvedValue({
			messageReferenceMatchers: [
				vi.fn(async () => [
					{
						bundleId: "hello",
						position: {
							start: { line: 1, character: 3 },
							end: { line: 1, character: 10 },
						},
					},
					{
						bundleId: "bye",
						position: {
							start: { line: 2, character: 5 },
							end: { line: 2, character: 12 },
						},
					},
				]),
			],
		} as never)
		vi.mocked(resolveLintRules).mockResolvedValue([
			{
				name: "testRule",
				ruleFn: (async (bundleId: string) => [
					{ bundleId, code: `lint-${bundleId}`, description: `desc-${bundleId}` },
				]) as never,
			},
		])
		vi.mocked(selectBundleById).mockImplementation((async (_project: never, bundleId: string) => ({
			id: bundleId,
		})) as never)

		await linterDiagnostics({
			subscriptions: [],
			fs: {} as never,
			session: {
				project: {},
				runTask: async <T>(task: () => Promise<T>) => ({
					status: "completed" as const,
					value: await task(),
				}),
			} as never,
		})

		mocks.projectChangeListener?.()
		await vi.waitFor(() => expect(mocks.setDiagnostics).toHaveBeenCalledTimes(1))

		const diagnostics = mocks.setDiagnostics.mock.calls[0]![1] as Array<{
			range: {
				start: { line: number; character: number }
				end: { line: number; character: number }
			}
			message: string
		}>
		expect(diagnostics).toHaveLength(2)
		const rangeByMessage = new Map(
			diagnostics.map((diagnostic) => [diagnostic.message, diagnostic.range])
		)
		expect(rangeByMessage.get("[lint-hello] - desc-hello")).toMatchObject({
			start: { line: 0, character: 2 },
			end: { line: 0, character: 9 },
		})
		expect(rangeByMessage.get("[lint-bye] - desc-bye")).toMatchObject({
			start: { line: 1, character: 4 },
			end: { line: 1, character: 11 },
		})
	})
})
