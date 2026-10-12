import { beforeEach, describe, expect, it, vi } from "vitest"
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
