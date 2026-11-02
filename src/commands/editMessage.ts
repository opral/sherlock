import { msg } from "../utilities/messages/msg.js"
import { commands, window } from "vscode"
import { CONFIGURATION } from "../configuration.js"
import { type BundleRow, type InlangProject } from "@inlang/sdk"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"
import { selectBundleById } from "../utilities/project/selectBundleById.js"
import { patternToEditorText, textToPattern } from "../utilities/messages/pattern.js"
import { applyChanges } from "../utilities/editor/helper/handleBundleUpdate.js"
import { saveProjectResources } from "../utilities/project/projectResourceSynchronization.js"
import { mutateBundle } from "../utilities/editor/helper/mutateBundle.js"

export const editMessageCommand = {
	command: "sherlock.editMessage",
	title: "Sherlock: Edit a Message",
	register: commands.registerCommand,
	callback: async function ({ bundleId, locale }: { bundleId: BundleRow["id"]; locale: string }) {
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
		const stringPattern = patternToEditorText(variant.pattern)

		const newValue = await window.showInputBox({
			title: "Enter new value:",
			value: stringPattern,
		})

		if (newValue === undefined) {
			return
		}

		try {
			const updated = await lease.runTask(() =>
				mutateBundle(lease.project, bundleId, async (current) => {
					const currentMessage = current?.messages.find((entry) => entry.locale === locale)
					const currentVariant = currentMessage?.variants.find((entry) => entry.id === variant.id)
					if (!current || !currentVariant)
						throw new Error(
							`Translation "${bundleId}" (${locale}) changed while the input was open.`
						)
					await applyChanges(lease.project.db, [
						{
							entity: "variant",
							entityId: currentVariant.id,
							newData: {
								...currentVariant,
								pattern: textToPattern(newValue, currentVariant.pattern),
							},
						},
					])
					await saveProjectResources(lease.project, lease.path)
					return true
				})
			)
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
