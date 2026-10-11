import { beforeEach, describe, expect, it, vi } from "vitest"
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
})
