import { describe, expect, it } from "vitest"
import { CLOUD_FEATURES, CLOUD_INTEREST_FORM_URL, machineTranslateCommand } from "./cloudContent.js"
import packageJson from "../../../package.json"

describe("cloud hint", () => {
	it("opens the interest form with Sherlock pre-selected", () => {
		const url = new URL(CLOUD_INTEREST_FORM_URL)
		expect(url.origin + url.pathname).toBe(
			"https://docs.google.com/forms/d/e/1FAIpQLSdwui1r1rFu1AXMPKa-g2ggDHOTvNFrmrxWDubaaYLHv8_4Mg/viewform"
		)
		expect(url.searchParams.get("usp")).toBe("pp_url")
		expect(url.searchParams.get("entry.14901479")).toBe("Sherlock")
	})

	it("lists the features of Parrot's Cloud tab and the CLI, without a price", () => {
		const names = CLOUD_FEATURES.flatMap((group) => group.features.map((feature) => feature.name))
		expect(names).toEqual([
			"Automatic handoff between designers, developers, and translators",
			"AI translation",
			"Your terminology and tone",
			"Translations that fit the design",
			"Smart message keys",
		])
		expect(JSON.stringify(CLOUD_FEATURES)).not.toMatch(/[$€]|price|\/month/i)
	})

	it("shows the CLI command for the active project", () => {
		expect(machineTranslateCommand("./project.inlang")).toBe(
			"npx @inlang/cli machine translate --project ./project.inlang"
		)
		expect(machineTranslateCommand("./my app/it's/project.inlang", "darwin")).toBe(
			"npx @inlang/cli machine translate --project './my app/it'\\''s/project.inlang'"
		)
		expect(machineTranslateCommand("./my app/project.inlang", "win32")).toBe(
			'npx @inlang/cli machine translate --project "./my app/project.inlang"'
		)
		// the CLI requires --project
		expect(machineTranslateCommand(undefined)).toBe(
			"npx @inlang/cli machine translate --project ./project.inlang"
		)
	})

	it("contributes the commands", () => {
		const commands = packageJson.contributes.commands.map((command) => command.command)
		expect(commands).toContain("sherlock.machineTranslate")
		expect(commands).toContain("sherlock.openCloud")
	})
})
