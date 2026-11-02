import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BundleNested } from "@inlang/sdk"
import { editMessageCommand } from "./editMessage.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"
import { applyChanges } from "../utilities/editor/helper/handleBundleUpdate.js"
import { saveProjectResources } from "../utilities/project/projectResourceSynchronization.js"
import { msg } from "../utilities/messages/msg.js"
import { CONFIGURATION } from "../configuration.js"

const host = vi.hoisted(() => ({
	project: { db: {} },
	active: true,
	input: vi.fn(),
	runTask: vi.fn(),
}))
vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	window: { showInputBox: host.input },
}))
vi.mock("../utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({
		activeProject: () =>
			host.active
				? {
						project: host.project,
						path: "/workspace/project.inlang",
						runTask: host.runTask,
					}
				: undefined,
	}),
}))
vi.mock("../utilities/project/selectBundleById.js", () => ({ selectBundleById: vi.fn() }))
vi.mock("../utilities/editor/helper/handleBundleUpdate.js", () => ({ applyChanges: vi.fn() }))
vi.mock("../utilities/project/projectResourceSynchronization.js", () => ({
	saveProjectResources: vi.fn(),
}))
vi.mock("../utilities/messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("../configuration.js", () => ({
	CONFIGURATION: { EVENTS: { ON_DID_EDIT_MESSAGE: { fire: vi.fn() } } },
}))

const bundle = (): BundleNested => ({
	id: "hello",
	declarations: [],
	messages: [
		{
			id: "m",
			bundle_id: "hello",
			locale: "en",
			selectors: [],
			variants: [
				{ id: "v", message_id: "m", matches: [], pattern: [{ type: "text", value: "Before" }] },
			],
		},
	],
})

describe("editMessageCommand", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		host.active = true
		host.runTask.mockImplementation(async (task: () => Promise<unknown>) => ({
			status: "completed",
			value: await task(),
		}))
		vi.mocked(selectBundleById).mockResolvedValue(bundle())
	})

	it("requires an active project", async () => {
		host.active = false
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(msg).toHaveBeenCalledWith("No active project.")
		expect(host.input).not.toHaveBeenCalled()
	})
	it.each([
		[undefined, "Bundle with id hello not found."],
		[{ ...bundle(), messages: [] }, "Message with locale en not found."],
		[
			{ ...bundle(), messages: [{ ...bundle().messages[0]!, variants: [] }] },
			"Variant with locale en not found.",
		],
	])("reports a missing translation", async (value, expected) => {
		vi.mocked(selectBundleById).mockResolvedValue(value)
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(msg).toHaveBeenCalledWith(expected)
		expect(host.input).not.toHaveBeenCalled()
	})

	it("cancels only when input is undefined", async () => {
		host.input.mockResolvedValue(undefined)
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(host.input).toHaveBeenCalledWith({ title: "Enter new value:", value: "Before" })
		expect(applyChanges).not.toHaveBeenCalled()
		expect(saveProjectResources).not.toHaveBeenCalled()
	})

	it("writes an empty translation and saves before reporting success", async () => {
		host.input.mockResolvedValue("")
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(applyChanges).toHaveBeenCalledExactlyOnceWith(host.project.db, [
			{
				entity: "variant",
				entityId: "v",
				newData: { ...bundle().messages[0]!.variants[0]!, pattern: [] },
			},
		])
		expect(saveProjectResources).toHaveBeenCalledExactlyOnceWith(
			host.project,
			"/workspace/project.inlang"
		)
		expect(vi.mocked(saveProjectResources).mock.invocationCallOrder[0]).toBeGreaterThan(
			vi.mocked(applyChanges).mock.invocationCallOrder[0]!
		)
		expect(msg).toHaveBeenCalledWith("Message updated.")
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).toHaveBeenCalledOnce()
	})

	it("keeps fresh variant metadata when the input dialog outlives another edit", async () => {
		const latest = bundle()
		latest.messages[0]!.variants[0]!.matches = [{ type: "catchall-match", key: "kind" }]
		vi.mocked(selectBundleById).mockResolvedValueOnce(bundle()).mockResolvedValueOnce(latest)
		host.input.mockResolvedValue("After {name}")
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(applyChanges).toHaveBeenCalledWith(host.project.db, [
			{
				entity: "variant",
				entityId: "v",
				newData: {
					...latest.messages[0]!.variants[0]!,
					pattern: [
						{ type: "text", value: "After " },
						{ type: "expression", arg: { type: "variable-reference", name: "name" } },
					],
				},
			},
		])
	})

	it("does not write after the project lease becomes inactive", async () => {
		host.input.mockResolvedValue("After")
		host.runTask
			.mockImplementationOnce(async (task: () => Promise<unknown>) => ({
				status: "completed",
				value: await task(),
			}))
			.mockResolvedValueOnce({ status: "inactive" })
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(applyChanges).not.toHaveBeenCalled()
		expect(msg).toHaveBeenCalledWith("The active project changed before the message was updated.")
	})

	it("reports persistence failures without success", async () => {
		host.input.mockResolvedValue("After")
		vi.mocked(saveProjectResources).mockRejectedValueOnce(new Error("Disk full"))
		await editMessageCommand.callback({ bundleId: "hello", locale: "en" })
		expect(msg).toHaveBeenCalledWith("Couldn't update bundle with id hello. Error: Disk full")
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).not.toHaveBeenCalled()
	})
})
