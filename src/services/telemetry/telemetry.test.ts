import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	sender: undefined as
		| undefined
		| { sendEventData(name: string, data?: Record<string, unknown>): void },
	logUsage: vi.fn(),
	createTelemetryLogger: vi.fn(),
	isProduction: true,
	usageEnabled: true,
	legacyUserId: undefined as string | undefined,
	update: vi.fn(async () => undefined),
	state: undefined as unknown,
}))

vi.mock("vscode", () => ({
	version: "1.141.0",
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	ConfigurationTarget: { Global: 1 },
	workspace: {
		getConfiguration: () => ({
			inspect: () => ({ globalValue: mocks.legacyUserId }),
			update: mocks.update,
		}),
	},
	env: {
		machineId: "machine-id-raw",
		appName: "Visual Studio Code",
		createTelemetryLogger: mocks.createTelemetryLogger,
	},
}))
vi.mock("../env-variables/index.js", () => ({
	ENV_VARIABLES: {
		get IS_PRODUCTION() {
			return mocks.isProduction
		},
	},
}))
vi.mock("../../utilities/state.js", () => ({
	state: () => mocks.state,
}))

const PROJECT_PATH = "/home/someone/secret-app/project.inlang"
// A project loaded from a directory gets a new id on every load, the path stays the same.
const activeProject = (path: string, id: string) => ({
	project: { id: { get: async () => id } },
	selectedProjectPath: path,
	projectsInWorkspace: [],
})

const fetchMock = vi.fn(async () => new Response("{}"))
vi.stubGlobal("fetch", fetchMock)

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	mocks.isProduction = true
	mocks.usageEnabled = true
	mocks.state = activeProject(PROJECT_PATH, "lix-id-of-this-load")
	mocks.createTelemetryLogger.mockImplementation((sender) => {
		mocks.sender = sender
		return { logUsage: mocks.logUsage, dispose: vi.fn(), isUsageEnabled: mocks.usageEnabled }
	})
})

describe("telemetry", () => {
	it("sends nothing from a development run", async () => {
		const telemetry = await import("./index.js")
		expect(telemetry.initTelemetry({ extensionMode: 2, version: "2.5.0" })).toBeUndefined()
		await telemetry.capture({ event: "app:session_start" })
		expect(mocks.createTelemetryLogger).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("sends nothing from a development build", async () => {
		mocks.isProduction = false
		const telemetry = await import("./index.js")
		expect(telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })).toBeUndefined()
	})

	it("logs usage through VS Code's telemetry logger, which applies telemetry.telemetryLevel", async () => {
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		expect(mocks.createTelemetryLogger).toHaveBeenCalledWith(expect.anything(), {
			ignoreBuiltInCommonProperties: true,
			ignoreUnhandledErrors: true,
		})
		await telemetry.capture({
			event: "cloud:interest_button_click",
			properties: { source: "editor" },
		})
		expect(mocks.logUsage).toHaveBeenCalledWith("cloud:interest_button_click", {
			source: "editor",
			project_id: telemetry.hashProjectPath(PROJECT_PATH),
		})
	})

	it("captures nothing below telemetry level all", async () => {
		mocks.usageEnabled = false
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		await telemetry.capture({ event: "app:session_start" })
		expect(mocks.logUsage).not.toHaveBeenCalled()
	})

	it("posts to PostHog US through the inlang.com relay with hashed ids and the app property", async () => {
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		// VS Code prefixes the extension id
		mocks.sender!.sendEventData("inlang.vs-code-extension/app:session_start", { project_id: "abc" })
		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe("https://inlang.com/relay/i/v0/e/")
		const body = JSON.parse(String(init.body))
		expect(body).toMatchObject({
			event: "app:session_start",
			distinct_id: telemetry.hashId("machine-id-raw"),
			properties: {
				app: "sherlock",
				app_version: "2.5.0",
				vscode_version: "1.141.0",
				editor: "Visual Studio Code",
				project_id: "abc",
			},
		})
		expect(JSON.stringify(body)).not.toContain("machine-id-raw")
		expect(body.api_key).toMatch(/^phc_/)
	})

	it("tells whether usage events are sent, for work that is only needed to build an event", async () => {
		const telemetry = await import("./index.js")
		// not started yet
		expect(telemetry.isUsageEnabled()).toBe(false)
		// development run: never started
		telemetry.initTelemetry({ extensionMode: 2, version: "2.5.0" })
		expect(telemetry.isUsageEnabled()).toBe(false)

		mocks.usageEnabled = false
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		expect(telemetry.isUsageEnabled()).toBe(false)

		mocks.usageEnabled = true
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		expect(telemetry.isUsageEnabled()).toBe(true)
	})

	it("posts project:project_view with the size of the project like Fink and Parrot do", async () => {
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		await telemetry.capture({
			event: "project:project_view",
			properties: {
				message_count: 1234,
				language_count: 7,
				error_count: 0,
				in_workspace_recommendation: false,
			},
		})
		const [name, data] = mocks.logUsage.mock.calls[0] as unknown as [
			string,
			Record<string, unknown>,
		]
		expect(name).toBe("project:project_view")

		// what VS Code's logger hands to the sender, with the extension id in front
		mocks.sender!.sendEventData(`inlang.vs-code-extension/${name}`, data)
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		const body = JSON.parse(String(init.body))
		expect(body.event).toBe("project:project_view")
		expect(body.properties).toMatchObject({
			app: "sherlock",
			message_count: 1234,
			language_count: 7,
			error_count: 0,
			in_workspace_recommendation: false,
			project_id: telemetry.hashProjectPath(PROJECT_PATH),
		})
	})

	it("identifies a project by its path, not by the id that a project gets on every load", async () => {
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		const projectIds = async () => {
			mocks.logUsage.mockClear()
			await telemetry.capture({ event: "app:session_start" })
			return (mocks.logUsage.mock.calls[0]![1] as { project_id?: string }).project_id
		}

		const firstLoad = await projectIds()
		// the same project, loaded again (reload, restart, switching back): a new Lix id
		mocks.state = activeProject(PROJECT_PATH, "another-lix-id")
		const secondLoad = await projectIds()
		mocks.state = activeProject("/home/someone/secret-app/other.inlang", "lix-id-of-this-load")
		const otherProject = await projectIds()

		expect(firstLoad).toMatch(/^[0-9a-f]{32}$/)
		expect(secondLoad).toBe(firstLoad)
		expect(otherProject).not.toBe(firstLoad)
	})

	it("does not send the project path, nor a hash of it that can be guessed without the machine", async () => {
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		await telemetry.capture({ event: "app:session_start" })
		const properties = mocks.logUsage.mock.calls[0]![1] as Record<string, unknown>

		expect(JSON.stringify(properties)).not.toContain("secret-app")
		expect(properties.project_id).not.toBe(telemetry.hashId(PROJECT_PATH))
		expect(properties.project_id).toBe(telemetry.hashProjectPath(PROJECT_PATH))
	})

	it("gives the same project the same id whichever way its path is written, and a machine its own ids", async () => {
		const telemetry = await import("./index.js")
		// fast-glob finds "C:/work/p.inlang" at activation, the project tree passes path.normalize()d "C:\\work\\p.inlang"
		expect(telemetry.hashProjectPath("C:\\work\\p.inlang")).toBe(
			telemetry.hashProjectPath("C:/work/p.inlang")
		)

		const idOnThisMachine = telemetry.hashProjectPath(PROJECT_PATH)
		const vscode = await import("vscode")
		const env = vscode.env as { machineId: string }
		env.machineId = "another-machine-id"
		try {
			expect(telemetry.hashProjectPath(PROJECT_PATH)).not.toBe(idOnThisMachine)
		} finally {
			env.machineId = "machine-id-raw"
		}
	})

	it("adds no project id without an active project", async () => {
		const telemetry = await import("./index.js")
		telemetry.initTelemetry({ extensionMode: 1, version: "2.5.0" })
		mocks.state = { projectsInWorkspace: [], selectedProjectPath: "" }
		await telemetry.capture({ event: "app:session_start" })
		expect(mocks.logUsage).toHaveBeenCalledWith("app:session_start", { project_id: undefined })

		// state that is not initialized yet
		mocks.state = undefined
		await telemetry.capture({ event: "app:session_start" })
		expect(mocks.logUsage).toHaveBeenLastCalledWith("app:session_start", { project_id: undefined })
	})

	it("removes the user id that earlier versions wrote into the user settings", async () => {
		const telemetry = await import("./index.js")
		await telemetry.removeLegacyUserId()
		expect(mocks.update).not.toHaveBeenCalled()
		mocks.legacyUserId = "123e4567-e89b-12d3-a456-426614174000"
		await telemetry.removeLegacyUserId()
		expect(mocks.update).toHaveBeenCalledWith("userId", undefined, 1)
	})
})
