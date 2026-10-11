import { describe, expect, it, vi } from "vitest"
import type { BundleNested } from "@inlang/sdk"

vi.mock("vscode", () => ({
	MarkdownString: class {
		constructor(public value: string) {}
	},
	Uri: { parse: (value: string) => value },
}))
vi.mock("../configuration.js", () => ({
	INTERPOLATE: { COMMAND_URI: (command: string, args: string) => `command:${command}?${args}` },
}))
vi.mock("../utilities/state.js", () => ({ state: () => ({}) }))

const selectBundleById = vi.hoisted(() => vi.fn())
vi.mock("../utilities/project/selectBundleById.js", () => ({ selectBundleById }))

const { contextTooltip, translationProblems } = await import("./contextTooltip.js")

const text = (value: string) => ({ type: "text" as const, value })
const variable = (name: string) => ({
	type: "expression" as const,
	arg: { type: "variable-reference" as const, name },
})

const bundle: BundleNested = {
	id: "cart",
	declarations: [
		{ type: "input-variable", name: "count" },
		{
			type: "local-variable",
			name: "countPlural",
			value: {
				type: "expression",
				arg: { type: "variable-reference", name: "count" },
				annotation: { type: "function-reference", name: "plural", options: [] },
			},
		},
	],
	messages: [
		{
			id: "en",
			bundle_id: "cart",
			locale: "en",
			selectors: [{ type: "variable-reference", name: "countPlural" }],
			variants: [
				{
					id: "en-one",
					message_id: "en",
					matches: [{ type: "literal-match", key: "countPlural", value: "one" }],
					pattern: [variable("count"), text(" item")],
				},
				{
					id: "en-other",
					message_id: "en",
					matches: [{ type: "catchall-match", key: "countPlural" }],
					pattern: [variable("count"), text(" items")],
				},
			],
		},
		{
			id: "ru",
			bundle_id: "cart",
			locale: "ru",
			selectors: [{ type: "variable-reference", name: "countPlural" }],
			variants: [
				{
					id: "ru-other",
					message_id: "ru",
					matches: [{ type: "catchall-match", key: "countPlural" }],
					pattern: [variable("cnt"), text(" товара")],
				},
			],
		},
	],
}

describe("hover problems", () => {
	it("lists the SDK's translation problems per language", () => {
		const problems = translationProblems({
			bundle,
			locales: ["en", "ru", "de"],
			referenceLocale: "en",
		})
		expect(problems.get("en")).toBeUndefined()
		expect(problems.get("ru")).toEqual([
			"Missing {count}",
			"Unknown {cnt} – did you mean {count}?",
			"Missing forms: one; few; many",
		])
		// a missing translation shows as "[missing]" instead
		expect(problems.get("de")).toBeUndefined()
	})

	it("shows them below the translation in the hover", async () => {
		selectBundleById.mockResolvedValueOnce(bundle)
		const project = {
			settings: { get: async () => ({ baseLocale: "en", locales: ["en", "ru"] }) },
		}
		const tooltip = (await contextTooltip(
			{ bundleId: "cart" } as any,
			project as any
		)) as unknown as {
			value: string
		}
		expect(tooltip.value).toContain(
			"$(warning) Missing {count} · Unknown {cnt} – did you mean {count}?"
		)
	})
})
