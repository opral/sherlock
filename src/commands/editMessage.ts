import { msg } from "../utilities/messages/msg.js"
import { commands, window } from "vscode"
import { getPatternFromString, getStringFromPattern } from "../utilities/messages/query.js"
import { CONFIGURATION } from "../configuration.js"
import { type Bundle, type InlangProject } from "@inlang/sdk"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"

export const editMessageCommand = {
	command: "sherlock.editMessage",
	title: "Sherlock: Edit a Message",
	register: commands.registerCommand,
	callback: async function ({ bundleId, locale }: { bundleId: Bundle["id"]; locale: string }) {
		const lease = getProjectRuntime<InlangProject>().activeProject()
		if (!lease) return msg("No active project.")
		const bundleResult = await lease.runTask(() => selectBundleById(lease.project, bundleId))
		if (bundleResult.status !== "completed") return
		const bundle = bundleResult.value

		if (!bundle) {
			return msg(`Bundle with id ${bundleId} not found.`)
		}

		const message = bundle.messages.find((m) => m.locale === locale)

		if (!message) {
			return msg(`Message with locale ${locale} not found.`)
		}

		const variant = message?.variants.find((v) => v.matches.length === 0)

		if (!variant) {
			return msg(`Variant with locale ${locale} not found.`)
		}

		// Construct the complete pattern text
		const stringPattern = getStringFromPattern({
			pattern: variant.pattern,
			locale,
			messageId: message.id,
		})

		const newValue = await window.showInputBox({
			title: "Enter new value:",
			value: stringPattern,
		})

		if (!newValue) {
			return
		}

		variant.pattern = getPatternFromString({ string: newValue })

		try {
			const updated = await lease.runTask(async () => {
				await lease.project.db.transaction().execute(async (trx) => {
					await trx
						.updateTable("inlang_message")
						.set({
							selectors: message.selectors,
						})
						.where("inlang_message.id", "=", message.id)
						.execute()

					return await trx
						.updateTable("inlang_variant")
						.set({
							pattern: variant.pattern,
						})
						.where("inlang_variant.id", "=", variant.id)
						.returningAll()
						.execute()
				})
				return true
			})
			if (updated.status !== "completed") {
				return msg("The active project changed before the message was updated.")
			}

			CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()

			return msg("Message updated.")
		} catch (e) {
			return msg(`Couldn't update bundle with id ${bundleId}. ${e}`)
		}
	},
} as const
