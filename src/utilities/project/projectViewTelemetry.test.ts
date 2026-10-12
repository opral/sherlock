import { beforeEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"
import type { FileSystem } from "../fs/createFileSystemMapper.js"

const mocks = vi.hoisted(() => ({
	capture: vi.fn(async (..._args: unknown[]) => undefined),
	isUsageEnabled: vi.fn(() => true),
	shouldRecommend: vi.fn(async (..._args: unknown[]) => false),
	getProjectSize: vi.fn(async (..._args: unknown[]) => ({ messageCount: 1234, languageCount: 7 })),
	activeProject: vi.fn(),
}))

vi.mock("../../services/telemetry/index.js", () => ({
	capture: mocks.capture,
	isUsageEnabled: mocks.isUsageEnabled,
}))
vi.mock("@inlang/recommend-sherlock", () => ({ shouldRecommend: mocks.shouldRecommend }))
vi.mock("./projectSize.js", () => ({ getProjectSize: mocks.getProjectSize }))
vi.mock("./projectRuntime.js", () => ({
	getProjectRuntime: () => ({ activeProject: mocks.activeProject }),
}))

import { captureProjectView } from "./projectViewTelemetry.js"

const fs = {} as FileSystem
const workspaceFolder = { uri: { fsPath: "/secret/workspace" } } as vscode.WorkspaceFolder

function lease(overrides: Record<string, unknown> = {}) {
	const project = {
		errors: { get: vi.fn(async () => [new Error("/secret/workspace/en.json: broken")]) },
	}
	return {
		path: "/secret/workspace/project.inlang",
		project,
		isCurrent: vi.fn(() => true),
		runTask: vi.fn(async <T>(task: () => Promise<T>) => ({
			status: "completed" as const,
			value: await task(),
		})),
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.isUsageEnabled.mockReturnValue(true)
	mocks.shouldRecommend.mockResolvedValue(false)
	mocks.getProjectSize.mockResolvedValue({ messageCount: 1234, languageCount: 7 })
	mocks.capture.mockResolvedValue(undefined)
	mocks.activeProject.mockReturnValue(lease())
})

describe("captureProjectView", () => {
	it("sends project:project_view with the size of the project, the error count and the recommendation", async () => {
		const active = lease()
		mocks.activeProject.mockReturnValue(active)
		mocks.shouldRecommend.mockResolvedValue(true)

		await captureProjectView({ fs, workspaceFolder })

		expect(mocks.getProjectSize).toHaveBeenCalledWith(active.project)
		expect(mocks.shouldRecommend).toHaveBeenCalledWith({
			fs,
			workingDirectory: "/secret/workspace",
		})
		expect(mocks.capture).toHaveBeenCalledOnce()
		expect(mocks.capture).toHaveBeenCalledWith({
			event: "project:project_view",
			properties: {
				message_count: 1234,
				language_count: 7,
				// a count: errors can contain paths
				error_count: 1,
				in_workspace_recommendation: true,
			},
		})
	})

	it("sends only numbers and booleans: no texts, keys, file names or paths", async () => {
		await captureProjectView({ fs, workspaceFolder })

		const { properties } = mocks.capture.mock.calls[0]![0] as {
			properties: Record<string, unknown>
		}
		expect(Object.keys(properties).sort()).toEqual([
			"error_count",
			"in_workspace_recommendation",
			"language_count",
			"message_count",
		])
		for (const value of Object.values(properties)) {
			expect(["number", "boolean"]).toContain(typeof value)
		}
		expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("secret")
	})

	it("does no work at all when usage data is not sent", async () => {
		mocks.isUsageEnabled.mockReturnValue(false)

		await captureProjectView({ fs, workspaceFolder })

		expect(mocks.activeProject).not.toHaveBeenCalled()
		expect(mocks.getProjectSize).not.toHaveBeenCalled()
		expect(mocks.shouldRecommend).not.toHaveBeenCalled()
		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it("sends nothing without an active project", async () => {
		mocks.activeProject.mockReturnValue(undefined)

		await captureProjectView({ fs, workspaceFolder })

		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it("sends nothing if the project was closed while counting", async () => {
		mocks.activeProject.mockReturnValue(
			lease({ runTask: vi.fn(async () => ({ status: "inactive" as const })) })
		)

		await captureProjectView({ fs, workspaceFolder })

		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it("sends nothing if another project replaced it while counting: that one reports itself", async () => {
		let current = true
		mocks.activeProject.mockReturnValue(
			lease({
				isCurrent: vi.fn(() => current),
				// the user switches project while the counts are being read
				runTask: vi.fn(async <T>(task: () => Promise<T>) => {
					const value = await task()
					current = false
					return { status: "completed" as const, value }
				}),
			})
		)

		await captureProjectView({ fs, workspaceFolder })

		expect(mocks.getProjectSize).toHaveBeenCalledOnce()
		expect(mocks.capture).not.toHaveBeenCalled()
	})

	const failures: Array<[name: string, arrange: () => unknown, reachedCapture?: boolean]> = [
		["the count fails", () => mocks.getProjectSize.mockRejectedValueOnce(new Error("db closed"))],
		[
			"reading the errors fails",
			() =>
				mocks.activeProject.mockReturnValue(
					lease({
						project: {
							errors: {
								get: vi.fn(async () => {
									throw new Error("boom")
								}),
							},
						},
					})
				),
		],
		[
			"the recommendation lookup fails",
			() => mocks.shouldRecommend.mockRejectedValueOnce(new Error("EACCES")),
		],
		["capture fails", () => mocks.capture.mockRejectedValueOnce(new Error("offline")), true],
		[
			"the runtime is not initialized",
			() =>
				mocks.activeProject.mockImplementation(() => {
					throw new Error("Project runtime is not initialized")
				}),
		],
		[
			"telemetry state throws",
			() =>
				mocks.isUsageEnabled.mockImplementation(() => {
					throw new Error("no logger")
				}),
		],
	]

	it.each(failures)("never throws when %s", async (_name, arrange, reachedCapture = false) => {
		arrange()

		await expect(captureProjectView({ fs, workspaceFolder })).resolves.toBeUndefined()
		// the failure happened where it was meant to: nothing was sent before it, or capture was reached
		expect(mocks.capture).toHaveBeenCalledTimes(reachedCapture ? 1 : 0)
	})
})
