import { describe, expect, it } from "vitest"
import type { Pattern } from "@inlang/sdk"
import { patternToEditorText, patternToText, textToPattern } from "./pattern.js"

describe("lossless editor drafts", () => {
	const rich: Pattern = [
		{ type: "text", value: "Total " },
		{
			type: "markup-start",
			name: "link",
			options: [{ name: "target", value: { type: "variable-reference", name: "url" } }],
			attributes: [
				{ name: "external", value: true },
				{ name: "title", value: { type: "literal", value: 'Say "hello"' } },
			],
		},
		{
			type: "expression",
			arg: { type: "variable-reference", name: "amount" },
			annotation: {
				type: "function-reference",
				name: "number",
				options: [{ name: "currency", value: { type: "literal", value: "USD" } }],
			},
		},
		{ type: "markup-end", name: "link" },
		{ type: "markup-standalone", name: "br" },
		{ type: "expression", arg: { type: "literal", value: "literal" } },
	]

	it("preserves markup metadata, formatted expressions and literals when surrounding text changes", () => {
		const draft = textToPattern(`New ${patternToEditorText(rich)}`, rich)
		expect(draft).toEqual([{ type: "text", value: "New Total " }, ...rich.slice(1)])
		expect(rich[0]).toEqual({ type: "text", value: "Total " })
	})

	it("preserves the full original representation for a no-op edit", () => {
		const result = textToPattern(patternToEditorText(rich), rich)
		expect(result).toEqual(rich)
		expect(result).not.toBe(rich)
	})

	it("allows existing tags to be removed", () => {
		const original: Pattern = [
			{ type: "markup-start", name: "b" },
			{ type: "expression", arg: { type: "variable-reference", name: "time" } },
			{ type: "markup-end", name: "b" },
		]
		expect(textToPattern("{time}", original)).toEqual([original[1]])
	})

	it("leaves escaped placeholders as text", () => {
		expect(textToPattern("Hello \\{name\\}")).toEqual([{ type: "text", value: "Hello {name}" }])
	})
})

describe("unambiguous editor source", () => {
	it("round trips braces, backslashes, text tags, and literal expressions without previous tokens", () => {
		const pattern: Pattern = [
			{ type: "text", value: 'Literal {name}, \\ path, <b> and {"literal"} versus ' },
			{ type: "expression", arg: { type: "variable-reference", name: "name" } },
			{ type: "text", value: " and " },
			{ type: "expression", arg: { type: "literal", value: 'name } { " \\ end' } },
		]
		const source = patternToEditorText(pattern)
		expect(source).toContain("\\{name\\}")
		expect(source).toContain("\\<b>")
		expect(textToPattern(source)).toEqual(pattern)
	})

	it("keeps literal and variable expressions distinct with the same annotation", () => {
		const annotation = { type: "function-reference" as const, name: "number", options: [] }
		const literal: Pattern = [
			{ type: "expression", arg: { type: "literal", value: "amount" }, annotation },
		]
		const variable: Pattern = [
			{ type: "expression", arg: { type: "variable-reference", name: "amount" }, annotation },
		]
		expect(patternToEditorText(literal)).toBe('{"amount", number}')
		expect(patternToEditorText(variable)).toBe("{amount, number}")
		expect(textToPattern(patternToEditorText(literal))).toEqual(literal)
	})

	it("does not turn ordinary words into literal expressions when editing", () => {
		const pattern: Pattern = [
			{ type: "text", value: "literal " },
			{ type: "expression", arg: { type: "literal", value: "literal" } },
		]
		expect(textToPattern(`New ${patternToEditorText(pattern)}`, pattern)).toEqual([
			{ type: "text", value: "New literal " },
			pattern[1],
		])
	})
})

describe("markup token metadata", () => {
	it("distinguishes markup options from attributes with identical values", () => {
		const option: Pattern[number] = {
			type: "markup-standalone",
			name: "link",
			options: [{ name: "target", value: { type: "literal", value: "url" } }],
		}
		const attribute: Pattern[number] = {
			type: "markup-standalone",
			name: "link",
			attributes: [{ name: "target", value: { type: "literal", value: "url" } }],
		}
		const pattern: Pattern = [option, { type: "text", value: " and " }, attribute]
		expect(patternToEditorText([option])).not.toBe(patternToEditorText([attribute]))
		expect(textToPattern(`New ${patternToEditorText(pattern)}`, pattern)).toEqual([
			{ type: "text", value: "New " },
			...pattern,
		])
	})
})

describe("formatted expression drafts", () => {
	it("round trips formatted arguments and options without previous tokens", () => {
		const pattern: Pattern = [
			{
				type: "expression",
				arg: { type: "literal", value: "42" },
				annotation: {
					type: "function-reference",
					name: "number",
					options: [
						{ name: "currency", value: { type: "literal", value: 'US "dollar" {USD}' } },
						{ name: "locale", value: { type: "variable-reference", name: "locale" } },
					],
				},
			},
			{ type: "text", value: " versus " },
			{
				type: "expression",
				arg: { type: "variable-reference", name: "amount" },
				annotation: { type: "function-reference", name: "number", options: [] },
			},
		]
		expect(textToPattern(patternToEditorText(pattern))).toEqual(pattern)
	})
})

describe("rich markup edits", () => {
	it("parses edited literal and variable options and attributes without losing quoted greater-than signs", () => {
		const previous: Pattern = [
			{
				type: "markup-standalone",
				name: "link",
				options: [{ name: "target", value: { type: "variable-reference", name: "url" } }],
				attributes: [{ name: "title", value: { type: "literal", value: "Old title" } }],
			},
		]
		expect(
			textToPattern(
				'<link :target={nextUrl} :label="new > label" @title="New > title" @external/>',
				previous
			)
		).toEqual([
			{
				type: "markup-standalone",
				name: "link",
				options: [
					{ name: "target", value: { type: "variable-reference", name: "nextUrl" } },
					{ name: "label", value: { type: "literal", value: "new > label" } },
				],
				attributes: [
					{ name: "title", value: { type: "literal", value: "New > title" } },
					{ name: "external", value: true },
				],
			},
		])
	})

	it("parses changes to a previously imported literal option", () => {
		const previous: Pattern = [
			{
				type: "markup-start",
				name: "link",
				options: [{ name: "target", value: { type: "literal", value: "old" } }],
			},
		]
		expect(textToPattern('<link :target="new">', previous)).toEqual([
			{
				type: "markup-start",
				name: "link",
				options: [{ name: "target", value: { type: "literal", value: "new" } }],
			},
		])
	})

	it("leaves bare new tags and ordinary HTML attributes for the resource plugin", () => {
		expect(textToPattern('<b>new</b><a href="url">link</a>')).toEqual([
			{ type: "text", value: '<b>new</b><a href="url">link</a>' },
		])
	})
})

describe("explicit markup option source", () => {
	it("retains literal options when renaming tags and supports newly authored rich tags", () => {
		const previous: Pattern = [
			{
				type: "markup-standalone",
				name: "link",
				options: [{ name: "target", value: { type: "literal", value: "old" } }],
			},
		]
		const renamed: Pattern = [
			{
				type: "markup-standalone",
				name: "anchor",
				options: [{ name: "target", value: { type: "literal", value: "new" } }],
			},
		]
		expect(patternToEditorText(previous)).toBe('<link :target="old"/>')
		expect(textToPattern('<anchor :target="new"/>', previous)).toEqual(renamed)
		expect(textToPattern(patternToEditorText(renamed))).toEqual(renamed)
		expect(patternToText(renamed)).toBe('<anchor target="new"/>')
	})
})
