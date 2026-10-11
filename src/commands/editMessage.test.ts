import { beforeEach, describe, expect, it, vi } from "vitest"
import { window } from "vscode"
import { editMessageCommand } from "./editMessage.js" // Adjust the import path accordingly
import { state } from "../utilities/state.js"
import { msg } from "../utilities/messages/msg.js"
import { CONFIGURATION } from "../configuration.js"
import { getPatternFromString, getStringFromPattern } from "../utilities/messages/query.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"

const runtimeLease = vi.hoisted(() => ({
	runTask: vi.fn(),
	isCurrent: vi.fn(),
}))

vi.mock("vscode", () => ({
	commands: {
		registerCommand: vi.fn(),
	},
	window: {
		showInputBox: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("../utilities/state.js", () => ({
	state: vi.fn(),
}))

vi.mock("../utilities/messages/msg.js", () => ({
	msg: vi.fn(),
}))

vi.mock("../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
		},
	},
}))

vi.mock("../utilities/messages/query.js", () => ({
	getPatternFromString: vi.fn(),
	getStringFromPattern: vi.fn(),
}))

vi.mock("../utilities/project/selectBundleById.js", () => ({
	selectBundleById: vi.fn(),
}))

vi.mock("../utilities/project/projectResourceSynchronization.js", () => ({
	saveProjectResources: vi.fn(),
}))

vi.mock("../utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({
		activeProject: () => {
			const project = state().project
			return project
				? {
						project,
						path: "/workspace/project.inlang",
						isCurrent: runtimeLease.isCurrent,
						runTask: runtimeLease.runTask,
					}
				: undefined
		},
	}),
}))

describe("editMessageCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(selectBundleById).mockReset()
		vi.mocked(window.showInputBox).mockReset()
		runtimeLease.isCurrent.mockReset().mockReturnValue(true)
		runtimeLease.runTask.mockReset().mockImplementation(async (task: () => Promise<unknown>) => ({
			status: "completed",
			value: await task(),
		}))
	})

	it("should show a message if the bundle is not found", async () => {
		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				db: {
					transaction: vi.fn().mockReturnThis(),
				},
			},
		})

		vi.mocked(selectBundleById).mockResolvedValueOnce(undefined)

		await editMessageCommand.callback({ bundleId: "testBundle", locale: "en" })

		expect(msg).toHaveBeenCalledWith("Bundle with id testBundle not found.")
	})

	it("should show a message if the message is not found", async () => {
		const mockBundle = { id: "testBundle", declarations: [], messages: [] }

		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				db: {
					transaction: vi.fn().mockReturnThis(),
				},
			},
		})

		vi.mocked(selectBundleById).mockResolvedValueOnce(mockBundle)

		await editMessageCommand.callback({ bundleId: "testBundle", locale: "en" })

		expect(msg).toHaveBeenCalledWith("Message with locale en not found.")
	})

	it("should show a message if the variant is not found", async () => {
		const mockBundle = {
			id: "testBundle",
			messages: [
				{
					id: "testMessage",
					locale: "en",
					variants: [],
				},
			],
		}

		vi.mocked(state).mockReturnValue({
			project: {
				db: {
					// @ts-expect-error
					transaction: () => ({
						execute: vi.fn().mockResolvedValue({}),
					}),
				},
			},
		})

		// @ts-expect-error
		vi.mocked(selectBundleById).mockResolvedValueOnce(mockBundle)

		await editMessageCommand.callback({ bundleId: "testBundle", locale: "en" })

		expect(msg).toHaveBeenCalledWith("Variant with locale en not found.")
	})

	it("should cancel the operation if no new value is provided", async () => {
		const mockBundle = {
			id: "testBundle",
			messages: [
				{
					id: "testMessage",
					locale: "en",
					variants: [
						{
							id: "testVariant",
							matches: [
								{
									type: "match",
									name: "locale",
									value: { type: "literal", value: "en" },
								},
							],
							pattern: "mock-pattern",
						},
					],
				},
			],
		}

		vi.mocked(state).mockReturnValue({
			project: {
				db: {
					// @ts-expect-error
					transaction: () => ({
						execute: vi.fn().mockResolvedValue({}),
					}),
				},
			},
		})

		// @ts-expect-error
		vi.mocked(selectBundleById).mockResolvedValueOnce(mockBundle)

		vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined)

		await editMessageCommand.callback({ bundleId: "testBundle", locale: "en" })

		expect(state().project?.db.transaction().execute).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).not.toHaveBeenCalled()
	})

	it("does not update a message after its project lease becomes stale", async () => {
		const execute = vi.fn()
		vi.mocked(state).mockReturnValue({
			project: { db: { transaction: vi.fn(() => ({ execute })) } },
		} as any)
		vi.mocked(selectBundleById).mockResolvedValueOnce({
			id: "testBundle",
			declarations: [],
			messages: [
				{
					id: "testMessage",
					bundleId: "testBundle",
					locale: "en",
					selectors: [],
					variants: [{ id: "testVariant", messageId: "testMessage", matches: [], pattern: [] }],
				},
			],
		} as any)
		vi.mocked(getStringFromPattern).mockReturnValue("Current content")
		vi.mocked(getPatternFromString).mockReturnValue([])
		vi.mocked(window.showInputBox).mockResolvedValueOnce("Updated content")
		runtimeLease.runTask.mockImplementation(async (task: () => Promise<unknown>) =>
			runtimeLease.runTask.mock.calls.length === 1
				? { status: "completed", value: await task() }
				: { status: "inactive" }
		)

		await editMessageCommand.callback({ bundleId: "testBundle", locale: "en" })

		expect(runtimeLease.runTask).toHaveBeenCalledTimes(2)
		expect(window.showInputBox).toHaveBeenCalledTimes(1)
		expect(execute).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).not.toHaveBeenCalled()
		expect(msg).toHaveBeenCalledWith("The active project changed before the message was updated.")
	})

	it.todo("should update an existing message and variant", async () => {
		const mockBundle = {
			id: "testBundle",
			messages: [
				{
					id: "testMessage",
					bundleId: "testBundle",
					locale: "en",
					selectors: [],
					declarations: [],
					variants: [
						{
							id: "testVariant",
							messageId: "testMessage",
							pattern: [
								{
									type: "text",
									value: "Current content",
								},
							],
							matches: [],
						},
					],
				},
			],
		}

		// @ts-expect-error
		vi.mocked(selectBundleById).mockResolvedValue(mockBundle)

		const mockTransaction = {
			execute: vi.fn().mockResolvedValue({}),
		}

		vi.mocked(state).mockReturnValue({
			project: {
				db: {
					// @ts-expect-error
					transaction: vi.fn(() => mockTransaction),
				},
			},
		})

		vi.mocked(getStringFromPattern).mockReturnValue("Current content")
		vi.mocked(getPatternFromString).mockReturnValue([
			{
				type: "text",
				value: "Updated content",
			},
		])

		vi.mocked(window.showInputBox).mockResolvedValueOnce("Updated content")

		await editMessageCommand.callback({ bundleId: "testBundle", locale: "en" })

		expect(window.showInputBox).toHaveBeenCalledWith({
			title: "Enter new value:",
			value: "Current content",
		})
		expect(getPatternFromString).toHaveBeenCalledWith({
			string: "Updated content",
		})
		expect(mockTransaction.execute).toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).toHaveBeenCalled()
		expect(msg).toHaveBeenCalledWith("Message updated.")
	})

	it.todo("should handle errors during message update", async () => {
		const mockBundle = {
			id: "testBundle",
			messages: [
				{
					id: "testMessage",
					locale: "en",
					variants: [
						{
							id: "testVariant",
							matches: [],
							pattern: "mock-pattern",
						},
					],
				},
			],
		}

		const error = new Error("Some Error")

		const mockTransaction = {
			execute: vi.fn().mockRejectedValue(error),
		}

		vi.mocked(state).mockReturnValue({
			project: {
				db: {
					// @ts-expect-error
					transaction: vi.fn(() => mockTransaction),
				},
			},
		})

		// @ts-expect-error
		vi.mocked(selectBundleById).mockResolvedValue(mockBundle)
		vi.mocked(window.showInputBox).mockResolvedValue("Updated content")

		await editMessageCommand.callback({
			bundleId: mockBundle.id,
			locale: "en",
		})

		expect(mockTransaction.execute).toHaveBeenCalled()
		expect(msg).toHaveBeenCalledWith(
			`Couldn't update bundle with id ${mockBundle.id}. Error: ${error.message}`
		)
	})
})
