/**
 * What inlang Cloud will offer, worded like Parrot's Cloud tab and the CLI's `inlang cloud`
 * command (opral/inlang `packages/cli/src/commands/cloud`), so all apps say the same.
 */
export const CLOUD_FEATURES: {
	title: string
	features: { name: string; description: string }[]
}[] = [
	{
		title: "Design and code in sync",
		features: [
			{
				name: "Automatic handoff between designers, developers, and translators",
				description: "Through a CLI, REST API, or your CI. No more sending JSON files around.",
			},
		],
	},
	{
		title: "AI",
		features: [
			{
				name: "AI translation",
				description: "Fill in every missing language at once.",
			},
			{
				name: "Your terminology and tone",
				description: "Product names stay as they are. Your style guide is followed.",
			},
			{
				name: "Translations that fit the design",
				description: "Knows buttons from headings and keeps text within its space.",
			},
			{
				name: "Smart message keys",
				description: "Meaningful keys like checkout.continue_button, generated for you.",
			},
		],
	},
]

/**
 * The shared "Interest in Cloud" Google Form (also linked from Parrot, Fink and the CLI), with
 * "Sherlock" pre-selected for "Which product brought you here?" (entry 14901479; its options are
 * Parrot, Fink, Sherlock and Paraglide JS).
 */
export const CLOUD_INTEREST_FORM_URL =
	"https://docs.google.com/forms/d/e/1FAIpQLSdwui1r1rFu1AXMPKa-g2ggDHOTvNFrmrxWDubaaYLHv8_4Mg/viewform?usp=pp_url&entry.14901479=Sherlock"

/** The inlang CLI command that machine translates a project locally. */
export function machineTranslateCommand(projectPath: string | undefined) {
	const project = projectPath ? ` --project ${quoteArgument(projectPath)}` : ""
	return `npx @inlang/cli machine translate${project}`
}

function quoteArgument(value: string) {
	return /^[\w./\\:@-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`
}
