import { describe, expect, it } from "vitest"
import { previewVariant } from "./previewVariant.js"

const exactZero = {
	id: "zero",
	matches: [
		{ type: "literal-match" as const, key: "countPluralExact", value: "0" },
		{ type: "catchall-match" as const, key: "countPlural" },
	],
}
const one = {
	id: "one",
	matches: [
		{ type: "catchall-match" as const, key: "countPluralExact" },
		{ type: "literal-match" as const, key: "countPlural", value: "one" },
	],
}
const other = {
	id: "other",
	matches: [
		{ type: "catchall-match" as const, key: "countPluralExact" },
		{ type: "catchall-match" as const, key: "countPlural" },
	],
}

describe("previewVariant", () => {
	it("prefers the catch-all form over an exact number's form", () => {
		expect(previewVariant([exactZero, one, other])?.id).toBe("other")
	})
	it("takes a plural's explicit other key as the catch-all", () => {
		const literal = (value: string) => ({
			id: value,
			matches: [{ type: "literal-match" as const, key: "countPlural", value }],
		})
		expect(previewVariant([literal("one"), literal("other")])?.id).toBe("other")
	})
	it("takes the only variant of a simple message", () => {
		expect(previewVariant([{ id: "only", matches: [] }])?.id).toBe("only")
	})
	it("falls back to the first variant", () => {
		expect(previewVariant([one])?.id).toBe("one")
		expect(previewVariant([])).toBeUndefined()
	})
})
