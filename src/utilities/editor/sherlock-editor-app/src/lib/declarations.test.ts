import { describe, expect, it } from "vitest"
import type { BundleNested, Pattern } from "@inlang/sdk"
import { updateDeclarations } from "./declarations.js"

const variable = (name: string) => ({
	type: "expression" as const,
	arg: { type: "variable-reference" as const, name },
})
const bundleWith = (
	pattern: Pattern,
	declarations: BundleNested["declarations"]
): BundleNested => ({
	id: "b",
	declarations,
	messages: [
		{
			id: "m",
			bundle_id: "b",
			locale: "en",
			selectors: [],
			variants: [{ id: "v", message_id: "m", matches: [], pattern }],
		},
	],
})

describe("updateDeclarations", () => {
	it("declares a typed variable and drops it again once it is corrected", () => {
		const declaredHere = new Set<string>()
		const typo = [variable("nme")]
		const first = updateDeclarations(
			bundleWith(typo, [{ type: "input-variable", name: "name" }]),
			typo,
			declaredHere
		)
		expect(first.map((d) => d.name)).toEqual(["name", "nme"])

		const fixed = [variable("name")]
		const second = updateDeclarations(bundleWith(fixed, first), fixed, declaredHere)
		expect(second.map((d) => d.name)).toEqual(["name"])
	})

	it("never removes declarations the bundle had before", () => {
		const declaredHere = new Set<string>()
		const declarations = [{ type: "input-variable" as const, name: "unused" }]
		expect(updateDeclarations(bundleWith([], declarations), [], declaredHere)).toEqual(declarations)
	})
})
