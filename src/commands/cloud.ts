import { commands } from "vscode"
import { showCloudPanel } from "../utilities/cloud/cloudView.js"

/**
 * "Sherlock: Machine translate…": machine translation is a hosted service of inlang Cloud (coming
 * soon). Shows what's coming with the interest form, and the inlang CLI for translating locally.
 */
export const machineTranslateCommand = {
	command: "sherlock.machineTranslate",
	title: "Sherlock: Machine translate…",
	register: commands.registerCommand,
	callback: async function () {
		showCloudPanel({ source: "command" })
	},
} as const

/** "Sherlock: inlang Cloud": the same page. */
export const openCloudCommand = {
	command: "sherlock.openCloud",
	title: "Sherlock: inlang Cloud",
	register: commands.registerCommand,
	callback: async function () {
		showCloudPanel({ source: "command" })
	},
} as const
