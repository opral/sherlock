import { describe, expect, it } from "vitest"
import type { BundleNested } from "@inlang/sdk"
import { diffBundles } from "./diffBundles.js"

const bundle: BundleNested = {
	id: "greeting",
	declarations: [],
	messages: [
		{
			id: "m-en",
			bundle_id: "greeting",
			locale: "en",
			selectors: [],
			variants: [{ id: "v-en", message_id: "m-en", matches: [], pattern: [] }],
		},
	],
}

describe("diffBundles", () => {
	it("returns nothing for an equal bundle", () => {
		expect(diffBundles(bundle, structuredClone(bundle))).toEqual([])
	})

	it("returns only the rows that changed, with the inlang columns only", () => {
		const next = structuredClone(bundle)
		next.messages[0]!.variants[0]!.pattern = [{ type: "text", value: "Hello" }]
		// a column the database adds is never sent back
		;(next.messages[0]!.variants[0] as Record<string, unknown>).lixcol_change_id = "x"
		expect(diffBundles(bundle, next)).toEqual([
			{
				entity: "variant",
				entityId: "v-en",
				newData: {
					id: "v-en",
					message_id: "m-en",
					matches: [],
					pattern: [{ type: "text", value: "Hello" }],
				},
			},
		])
	})

	it("writes new messages before their variants and deletes variants before messages", () => {
		const next = structuredClone(bundle)
		next.messages = [
			{
				id: "m-de",
				bundle_id: "greeting",
				locale: "de",
				selectors: [],
				variants: [{ id: "v-de", message_id: "m-de", matches: [], pattern: [] }],
			},
		]
		next.declarations = [{ type: "input-variable", name: "name" }]
		expect(
			diffBundles(bundle, next).map((c) => `${c.entity}:${c.entityId}:${!!c.newData}`)
		).toEqual([
			"bundle:greeting:true",
			"message:m-de:true",
			"variant:v-de:true",
			"variant:v-en:false",
			"message:m-en:false",
		])
	})
})
