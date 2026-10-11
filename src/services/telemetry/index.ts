import * as vscode from "vscode"
import crypto from "node:crypto"
import { ENV_VARIABLES } from "../env-variables/index.js"
import { state } from "../../utilities/state.js"

/**
 * Usage telemetry, shared with the other inlang apps (Parrot, Fink, Paraglide JS) in one
 * PostHog project (US). Events follow PostHog's `category:object_action` naming; the app is a
 * property, not part of the event name. Only event names, counts and hashed ids are sent - never
 * message texts, message keys or file names.
 *
 * Events go through the reverse proxy on inlang.com. They are sent through VS Code's telemetry
 * logger, so they honour `telemetry.telemetryLevel`: usage events are only sent at level "all".
 * Development runs (Extension Development Host, tests) send nothing.
 */
const CAPTURE_URL = "https://inlang.com/relay/i/v0/e/"
// write-only project token - safe to ship in a client
const POSTHOG_TOKEN = "phc_xTDR5yXmkYykE7mct3fgxqDSFcJdg4nELhqWwEkUzdLH"

export type TelemetryEvent =
	| "app:session_start"
	| "project:project_load"
	| "message:message_create"
	| "message:message_extract"
	| "message:code_action_resolve"
	| "message:position_jump"
	| "editor:editor_open"
	| "settings:settings_view_open"
	| "recommendation:workspace_recommendation_accept"
	| "cloud:page_view"
	| "cloud:interest_button_click"

type Properties = Record<string, string | number | boolean | undefined>

let logger: vscode.TelemetryLogger | undefined
let appVersion = ""

/** A hash of an id, specific to Sherlock (salted), so that it can't be joined with other data. */
export function hashId(id: string) {
	return crypto.createHash("sha256").update(`sherlock:${id}`).digest("hex").slice(0, 32)
}

/**
 * VS Code puts the extension id in front of event names ("inlang.vs-code-extension/app:…").
 * The shared PostHog project uses the plain `category:object_action` names.
 */
export function eventNameWithoutExtensionId(eventName: string) {
	return eventName.slice(eventName.lastIndexOf("/") + 1)
}

export function buildCapturePayload(args: {
	event: string
	distinctId: string
	properties: Properties
	timestamp: string
}) {
	return {
		api_key: POSTHOG_TOKEN,
		event: args.event,
		distinct_id: args.distinctId,
		timestamp: args.timestamp,
		properties: {
			app: "sherlock",
			app_version: appVersion,
			vscode_version: vscode.version,
			// VS Code or a fork (Cursor, Windsurf, …)
			editor: vscode.env.appName,
			platform: process.platform,
			...args.properties,
		},
	}
}

/**
 * Starts telemetry for a production install. Returns the logger (to dispose with the extension),
 * or `undefined` when nothing is ever sent.
 */
export function initTelemetry(args: { extensionMode: vscode.ExtensionMode; version: string }) {
	appVersion = args.version
	if (args.extensionMode !== vscode.ExtensionMode.Production || !ENV_VARIABLES.IS_PRODUCTION) {
		return undefined
	}
	logger = vscode.env.createTelemetryLogger(
		{
			sendEventData(eventName, data) {
				const distinctId = hashId(vscode.env.machineId)
				fetch(CAPTURE_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						buildCapturePayload({
							event: eventNameWithoutExtensionId(eventName),
							distinctId,
							properties: (data ?? {}) as Properties,
							timestamp: new Date().toISOString(),
						})
					),
				}).catch(() => {
					// telemetry never gets in the user's way
				})
			},
			sendErrorData() {
				// errors are not sent
			},
		},
		{ ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true }
	)
	return logger
}

/**
 * Captures a usage event, if the user's telemetry level allows usage data. Adds the hashed id of
 * the active project.
 */
export async function capture(args: { event: TelemetryEvent; properties?: Properties }) {
	// usage data only at telemetry level "all": nothing to look up otherwise
	if (!logger?.isUsageEnabled) return
	let projectId: string | undefined
	try {
		const id = await state().project?.id.get()
		projectId = typeof id === "string" ? hashId(id) : undefined
	} catch {
		projectId = undefined
	}
	logger.logUsage(args.event, { ...args.properties, project_id: projectId })
}

/**
 * The PostHog EU client of earlier versions wrote a random `sherlock.userId` into the user
 * settings, even with telemetry off. It is no longer used: remove it.
 */
export async function removeLegacyUserId() {
	try {
		const configuration = vscode.workspace.getConfiguration("sherlock")
		if (configuration.inspect("userId")?.globalValue === undefined) return
		await configuration.update("userId", undefined, vscode.ConfigurationTarget.Global)
	} catch {
		// a leftover setting is harmless
	}
}
