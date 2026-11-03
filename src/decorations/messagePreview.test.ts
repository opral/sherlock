import { beforeEach, describe, expect, it, vi } from "vitest"
import { contextTooltip } from "./contextTooltip.js"
import { messagePreview } from "./messagePreview.js"

const mocks = vi.hoisted(() => ({
	setDecorations: vi.fn(),
	getPreviewLocale: vi.fn(),
	getSetting: vi.fn(),
	getExtensionApi: vi.fn(),
	selectBundleById: vi.fn(),
	projectChangeListener: undefined as (() => void) | undefined,
}))

vi.mock("vscode", () => ({
	Position: class Position {
		constructor(
			public line: number,
			public character: number
		) {}
	},
	Range: class Range {
		constructor(
			public start: unknown,
			public end: unknown
		) {}
	},
	ThemeColor: class ThemeColor {
		constructor(public id: string) {}
	},
	window: {
		activeTextEditor: {
			document: {
				fileName: "/workspace/src/page.ts",
				getText: vi.fn(() => "m.root_title()"),
			},
			setDecorations: mocks.setDecorations,
		},
		createTextEditorDecorationType: vi.fn(() => ({ key: "preview" })),
		onDidChangeActiveTextEditor: vi.fn(),
	},
	workspace: {
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) })),
		onDidChangeConfiguration: vi.fn(),
		onDidChangeTextDocument: vi.fn(),
	},
}))

vi.mock("../utilities/state.js", () => ({
	state: () => ({
		project: {
			settings: {
				get: vi.fn(async () => ({ baseLocale: "ckb", locales: ["ckb", "en"] })),
			},
		},
	}),
}))

vi.mock("./contextTooltip.js", () => ({
	contextTooltip: vi.fn(async () => undefined),
}))

vi.mock("../utilities/locale/getPreviewLocale.js", () => ({
	getPreviewLocale: mocks.getPreviewLocale,
}))

vi.mock("../utilities/settings/index.js", () => ({
	getSetting: mocks.getSetting,
}))

vi.mock("../utilities/helper.js", () => ({
	getExtensionApi: mocks.getExtensionApi,
}))

vi.mock("../utilities/project/selectBundleById.js", () => ({
	selectBundleById: mocks.selectBundleById,
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
			ON_DID_CREATE_MESSAGE: { event: vi.fn() },
			ON_DID_EDIT_MESSAGE: { event: vi.fn() },
			ON_DID_EXTRACT_MESSAGE: { event: vi.fn() },
			ON_DID_PREVIEW_LOCALE_CHANGE: { event: vi.fn() },
		},
	},
}))

describe("messagePreview", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.projectChangeListener = undefined
		mocks.getPreviewLocale.mockResolvedValue("en")
		mocks.getSetting.mockResolvedValue("transparent")
		mocks.getExtensionApi.mockResolvedValue({
			messageReferenceMatchers: [
				vi.fn(async () => [
					{
						bundleId: "root_title",
						position: {
							start: { line: 1, character: 1 },
							end: { line: 1, character: 15 },
						},
					},
				]),
			],
		})
		mocks.selectBundleById.mockResolvedValue({
			messages: [
				{
					locale: "ckb",
					variants: [
						{
							message_id: "root_title_ckb",
							matches: [{ type: "catchall-match" }],
							pattern: [{ type: "text", value: "سەردێڕ" }],
						},
					],
				},
				{
					locale: "en",
					variants: [
						{
							message_id: "root_title_en",
							matches: [{ type: "catchall-match" }],
							pattern: [{ type: "text", value: "Root title" }],
						},
					],
				},
			],
		})
	})

	it("renders the message for the selected preview locale", async () => {
		const project = {
			settings: {
				get: vi.fn(async () => ({ baseLocale: "ckb", locales: ["ckb", "en"] })),
			},
		}
		messagePreview({
			subscriptions: [],
			session: {
				path: "/workspace/project.inlang",
				project,
				runTask: async <T>(task: () => Promise<T>) => ({
					status: "completed" as const,
					value: await task(),
				}),
			} as never,
		})
		expect(mocks.setDecorations).not.toHaveBeenCalled()
		mocks.projectChangeListener?.()

		await vi.waitFor(() => {
			expect(mocks.setDecorations).toHaveBeenCalledWith(expect.anything(), [
				expect.objectContaining({
					renderOptions: expect.objectContaining({
						after: expect.objectContaining({ contentText: "Root title" }),
					}),
				}),
			])
		})
	})

	it("does not apply decorations computed by a session that became inactive", async () => {
		const project = {
			settings: {
				get: vi.fn(async () => ({ baseLocale: "ckb", locales: ["ckb", "en"] })),
			},
		}
		messagePreview({
			subscriptions: [],
			session: {
				path: "/workspace/project.inlang",
				project,
				runTask: async <T>(task: () => Promise<T>) => {
					await task()
					return { status: "inactive" as const }
				},
			} as never,
		})

		mocks.projectChangeListener?.()
		await vi.waitFor(() => expect(mocks.selectBundleById).toHaveBeenCalled())

		expect(mocks.setDecorations).not.toHaveBeenCalled()
	})

	it("bounds lookups across matchers and coalesces updates for a 129-reference file", async () => {
		const references = Array.from({ length: 129 }, (_, index) => ({
			bundleId: `key_${index}`,
			position: {
				start: { line: index + 1, character: 1 },
				end: { line: index + 1, character: 15 },
			},
		}))
		mocks.getExtensionApi.mockResolvedValue({
			messageReferenceMatchers: [
				async () => references.slice(0, 70),
				async () => references.slice(70),
			],
		})
		const settings = { baseLocale: "en", locales: ["en"] }
		const project = { settings: { get: vi.fn(async () => settings) } }
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		let active = 0
		let peak = 0
		mocks.selectBundleById.mockImplementation(async (_project, id) => {
			active += 1
			peak = Math.max(peak, active)
			await gate
			await new Promise<void>((resolve) => setImmediate(resolve))
			active -= 1
			return { id, declarations: [], messages: [] }
		})
		messagePreview({
			subscriptions: [],
			session: {
				project,
				runTask: async <T>(task: () => Promise<T>) => ({
					status: "completed" as const,
					value: await task(),
				}),
			} as never,
		})
		mocks.projectChangeListener?.()
		await vi.waitFor(() => expect(mocks.selectBundleById).toHaveBeenCalledTimes(8))
		// Source/project events during a slow lookup must not start another unbounded run.
		mocks.projectChangeListener?.()
		mocks.projectChangeListener?.()
		expect(mocks.selectBundleById).toHaveBeenCalledTimes(8)
		release()

		await vi.waitFor(() => expect(mocks.setDecorations).toHaveBeenCalledTimes(1))
		expect(mocks.setDecorations.mock.calls[0]![1]).toHaveLength(129)
		expect(peak).toBe(8)
		expect(mocks.selectBundleById).toHaveBeenCalledTimes(8 + 129)
		expect(mocks.getPreviewLocale).toHaveBeenCalledTimes(2)
		expect(project.settings.get).toHaveBeenCalledTimes(2)
		expect(contextTooltip).toHaveBeenLastCalledWith(references[128], project, {
			bundle: { id: "key_128", declarations: [], messages: [] },
			settings,
		})
	})

	it("retries a queued refresh after the current lookup fails", async () => {
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: ["en"] })) },
		}
		const error = new Error("Transient lookup failure")
		let reject!: (reason: Error) => void
		mocks.selectBundleById.mockImplementationOnce(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail
				})
		)
		const loggedError = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			messagePreview({
				subscriptions: [],
				session: {
					project,
					runTask: async <T>(task: () => Promise<T>) => ({
						status: "completed" as const,
						value: await task(),
					}),
				} as never,
			})
			mocks.projectChangeListener?.()
			await vi.waitFor(() => expect(mocks.selectBundleById).toHaveBeenCalledTimes(1))
			mocks.projectChangeListener?.()
			reject(error)

			await vi.waitFor(() => expect(mocks.setDecorations).toHaveBeenCalledTimes(1))
			expect(mocks.selectBundleById).toHaveBeenCalledTimes(2)
			expect(mocks.setDecorations.mock.calls[0]![1]).toHaveLength(1)
			expect(loggedError).toHaveBeenCalledWith(error)
		} finally {
			loggedError.mockRestore()
		}
	})
})
