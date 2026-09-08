import { msg } from "../utilities/messages/msg.js"
import { commands, window } from "vscode"
import { capture } from "../services/telemetry/index.js"
import { humanId, upsertBundleNested, type InlangProject, type NewBundleNested } from "@inlang/sdk"
import { CONFIGURATION } from "../configuration.js"
import { getSetting } from "../utilities/settings/index.js"
import { v4 as uuidv4 } from "uuid"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"
import { saveProjectResources } from "../utilities/project/projectResourceSynchronization.js"

/**
 * Helps the user to create messages by prompting for the message content.
 */
export const createMessageCommand = {
	command: "sherlock.createMessage",
	title: "Sherlock: Create Message",
	register: commands.registerCommand,
	callback: async function () {
		const lease = getProjectRuntime<InlangProject>().activeProject()
		if (!lease) return msg("No active project.")
		const baseLocaleResult = await lease.runTask(
			async () => (await lease.project.settings.get()).baseLocale
		)
		if (baseLocaleResult.status !== "completed") return
		const baseLocale = baseLocaleResult.value

		const messageValue = await window.showInputBox({
			title: "Enter the message content:",
		})

		if (messageValue === undefined) {
			return
		}

		// create random message id as default value
		const autoHumanId = await getSetting("extract.autoHumanId.enabled").catch(() => true)

		const bundleId = await window.showInputBox({
			title: "Enter the ID:",
			value: autoHumanId ? humanId() : "",
			prompt:
				(autoHumanId &&
					"Tip: It's best practice to use random names for your messages. Read this [post](https://inlang.com/blog/human-readable-message-ids) for more information.") ||
				undefined,
		})
		if (bundleId === undefined) {
			return
		}

		const messageId = uuidv4()
		const bundle: NewBundleNested = {
			id: bundleId,
			declarations: [],
			messages: [
				{
					bundleId,
					id: messageId,
					locale: baseLocale,
					selectors: [],
					variants: [
						{
							messageId,
							matches: [],
							pattern: [
								{
									type: "text",
									value: messageValue,
								},
							],
						},
					],
				},
			],
		}

		try {
			const created = await lease.runTask(async () => {
				await upsertBundleNested(lease.project.db, bundle)
				await saveProjectResources(lease.project, lease.path)
				return true
			})
			if (created.status !== "completed") {
				return msg("The active project changed before the message was created.")
			}

			// Emit event to notify that a message was created
			CONFIGURATION.EVENTS.ON_DID_CREATE_MESSAGE.fire()

			capture({
				event: "IDE-EXTENSION command executed: Create Message",
			})

			return msg("Message created.")
		} catch (e) {
			return window.showErrorMessage(`Couldn't create new message. ${e}`)
		}
	},
} as const
