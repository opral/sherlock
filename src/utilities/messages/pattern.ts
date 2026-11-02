import type { Pattern, VariantRow } from "@inlang/sdk"

export function unsupportedPatternTypes(pattern: Pattern): string[] {
	const unsupported = new Set<string>()
	for (const element of pattern) {
		switch (element.type) {
			case "text":
			case "markup-start":
			case "markup-end":
			case "markup-standalone":
				break
			case "expression":
				if (element.arg.type !== "variable-reference" && element.arg.type !== "literal") {
					unsupported.add(`expression ${(element.arg as { type: string }).type}`)
				}
				break
			default:
				unsupported.add((element as { type: string }).type)
		}
	}
	return [...unsupported]
}

function valueToText(
	value: { type: "literal"; value: string } | { type: "variable-reference"; name: string }
) {
	return value.type === "literal" ? JSON.stringify(value.value) : `{${value.name}}`
}

/** Plain display text. Callers escape it for their output format; rendering never notifies. */
export function patternToText(pattern: Pattern): string {
	return pattern
		.map((element) => {
			switch (element.type) {
				case "text":
					return element.value
				case "expression": {
					if (element.arg.type !== "variable-reference" && element.arg.type !== "literal") {
						return `[Unsupported expression: ${(element.arg as { type: string }).type}]`
					}
					const arg =
						element.arg.type === "variable-reference" ? element.arg.name : element.arg.value
					if (element.arg.type === "literal" && !element.annotation) return arg
					const annotation = element.annotation
					const format = annotation
						? `, ${annotation.name}${annotation.options.map((option) => ` ${option.name}=${valueToText(option.value)}`).join("")}`
						: ""
					return `{${arg}${format}}`
				}
				case "markup-start":
				case "markup-end":
				case "markup-standalone": {
					const options = (element.options ?? [])
						.map((option) => ` ${option.name}=${valueToText(option.value)}`)
						.join("")
					const attributes = (element.attributes ?? [])
						.map(
							(attribute) =>
								` ${attribute.name}${attribute.value === true ? "" : `=${JSON.stringify(attribute.value.value)}`}`
						)
						.join("")
					return `<${element.type === "markup-end" ? "/" : ""}${element.name}${options}${attributes}${element.type === "markup-standalone" ? "/" : ""}>`
				}
				default:
					return `[Unsupported pattern element: ${(element as { type: string }).type}]`
			}
		})
		.join("")
}

/** Editor source has distinct encodings for text, variable expressions and literal expressions. */
export function patternToEditorText(pattern: Pattern): string {
	return pattern
		.map((element) => {
			if (element.type === "text") return element.value.replace(/[\\{}<]/g, "\\$&")
			if (element.type === "expression" && element.arg.type === "literal") {
				const annotation = element.annotation
				const format = annotation
					? `, ${annotation.name}${annotation.options.map((option) => ` ${option.name}=${valueToText(option.value)}`).join("")}`
					: ""
				return `{${JSON.stringify(element.arg.value)}${format}}`
			}
			if (
				element.type === "markup-start" ||
				element.type === "markup-end" ||
				element.type === "markup-standalone"
			) {
				const options = (element.options ?? [])
					.map((option) => ` :${option.name}=${valueToText(option.value)}`)
					.join("")
				const attributes = (element.attributes ?? [])
					.map(
						(attribute) =>
							` @${attribute.name}${attribute.value === true ? "" : `=${JSON.stringify(attribute.value.value)}`}`
					)
					.join("")
				return `<${element.type === "markup-end" ? "/" : ""}${element.name}${options}${attributes}${element.type === "markup-standalone" ? "/" : ""}>`
			}
			return patternToText([element])
		})
		.join("")
}

function expressionEnd(text: string, start: number): number {
	let depth = 0
	let quoted = false
	for (let index = start; index < text.length; index++) {
		const character = text[index]
		if (quoted && character === "\\") {
			index++
			continue
		}
		if (character === '"') quoted = !quoted
		if (quoted) continue
		if (character === "{") depth++
		if (character === "}" && --depth === 0) return index
	}
	return -1
}

function quotedValue(source: string, start: number): { value: string; end: number } | undefined {
	let end = start + 1
	for (; end < source.length; end++) {
		if (source[end] === "\\") end++
		else if (source[end] === '"') break
	}
	try {
		return { value: JSON.parse(source.slice(start, end + 1)) as string, end: end + 1 }
	} catch {
		return undefined
	}
}

function parseExpression(source: string): Pattern[number] | undefined {
	let position = 0
	let arg: { type: "literal"; value: string } | { type: "variable-reference"; name: string }
	if (source.startsWith('"')) {
		const literal = quotedValue(source, 0)
		if (!literal) return undefined
		arg = { type: "literal", value: literal.value }
		position = literal.end
	} else {
		const comma = source.indexOf(",")
		const name = source.slice(0, comma === -1 ? source.length : comma).trim()
		if (!name || /[{}]/.test(name)) return undefined
		arg = { type: "variable-reference", name }
		position = comma === -1 ? source.length : comma
	}
	const suffix = source.slice(position).trim()
	if (!suffix) return { type: "expression", arg }
	if (!suffix.startsWith(",")) return undefined
	const format = suffix.slice(1).trim()
	const name = format.match(/^[^\s=]+/)?.[0]
	if (!name) return undefined
	const options: {
		name: string
		value: { type: "literal"; value: string } | { type: "variable-reference"; name: string }
	}[] = []
	position = name.length
	while (position < format.length) {
		while (/\s/.test(format[position] ?? "") && position < format.length) position++
		if (position === format.length) break
		const option = format.slice(position).match(/^([^\s=]+)=/)
		if (!option) return undefined
		position += option[0].length
		if (format[position] === '"') {
			const literal = quotedValue(format, position)
			if (!literal) return undefined
			options.push({ name: option[1]!, value: { type: "literal", value: literal.value } })
			position = literal.end
		} else if (format[position] === "{") {
			const end = format.indexOf("}", position + 1)
			if (end === -1) return undefined
			options.push({
				name: option[1]!,
				value: { type: "variable-reference", name: format.slice(position + 1, end) },
			})
			position = end + 1
		} else return undefined
	}
	return { type: "expression", arg, annotation: { type: "function-reference", name, options } }
}

function parseRichMarkup(
	text: string,
	start: number
): { element: Pattern[number]; end: number } | undefined {
	const opening = text.slice(start).match(/^<(\/?)([A-Za-z0-9][A-Za-z0-9_.-]*)/)
	if (!opening) return undefined
	let end = start + opening[0].length
	let quoted = false
	for (; end < text.length; end++) {
		if (quoted && text[end] === "\\") {
			end++
			continue
		}
		if (text[end] === '"') quoted = !quoted
		if (!quoted && text[end] === ">") break
	}
	if (end === text.length) return undefined
	const source = text.slice(start + opening[0].length, end)
	const standalone = /\/\s*$/.test(source)
	const body = standalone ? source.replace(/\/\s*$/, "") : source
	const type = opening[1] ? "markup-end" : standalone ? "markup-standalone" : "markup-start"
	const name = opening[2]!
	const options: NonNullable<Extract<Pattern[number], { type: "markup-start" }>["options"]> = []
	const attributes: NonNullable<Extract<Pattern[number], { type: "markup-start" }>["attributes"]> =
		[]
	let position = 0
	while (position < body.length) {
		if (!/\s/.test(body[position] ?? "")) return undefined
		while (position < body.length && /\s/.test(body[position]!)) position++
		if (position === body.length) break
		const property = body.slice(position).match(/^([:@])([A-Za-z_][A-Za-z0-9_.-]*)/)
		if (!property) return undefined
		position += property[0].length
		const isAttribute = property[1] === "@"
		const propertyName = property[2]!
		if (isAttribute && body[position] !== "=") {
			attributes.push({ name: propertyName, value: true })
			continue
		}
		if (body[position] !== "=") return undefined
		position++
		if (body[position] === '"') {
			const literal = quotedValue(body, position)
			if (!literal) return undefined
			const value = { type: "literal" as const, value: literal.value }
			if (isAttribute) attributes.push({ name: propertyName, value })
			else options.push({ name: propertyName, value })
			position = literal.end
		} else if (!isAttribute && body[position] === "{") {
			const close = body.indexOf("}", position + 1)
			if (close === -1) return undefined
			options.push({
				name: propertyName,
				value: { type: "variable-reference", name: body.slice(position + 1, close) },
			})
			position = close + 1
		} else return undefined
	}
	// Only explicitly marked options and attributes belong to the editor's rich syntax.
	// Ordinary newly typed HTML remains text for the resource plugin to interpret.
	if (!options.length && !attributes.length) return undefined
	return {
		element: {
			type,
			name,
			...(options.length ? { options } : {}),
			...(attributes.length ? { attributes } : {}),
		},
		end: end + 1,
	}
}

/**
 * Parse editor source into an exportable draft, retaining metadata on unchanged tokens.
 * The resource plugin subsequently parses this draft into its canonical representation.
 */
export function textToPattern(text: string, previousPattern: Pattern = []): Pattern {
	if (text === patternToEditorText(previousPattern)) return structuredClone(previousPattern)
	const tokens = previousPattern
		.filter((element) => element.type !== "text")
		.map((element) => ({ text: patternToEditorText([element]), element }))
		.filter((token) => token.text.length > 0)
		.sort((a, b) => b.text.length - a.text.length)
	const pattern: Pattern = []
	let buffer = ""
	const flush = () => {
		if (buffer) pattern.push({ type: "text", value: buffer })
		buffer = ""
	}
	for (let index = 0; index < text.length; ) {
		if (text[index] === "\\" && /[\\{}<>]/.test(text[index + 1] ?? "")) {
			buffer += text[index + 1]
			index += 2
			continue
		}
		const token = tokens.find((entry) => text.startsWith(entry.text, index))
		if (token) {
			flush()
			pattern.push(structuredClone(token.element))
			index += token.text.length
			continue
		}
		if (text[index] === "<") {
			const markup = parseRichMarkup(text, index)
			if (markup) {
				flush()
				pattern.push(markup.element)
				index = markup.end
				continue
			}
		}
		if (text[index] === "{") {
			const end = expressionEnd(text, index)
			const expression = end !== -1 ? parseExpression(text.slice(index + 1, end)) : undefined
			if (expression) {
				flush()
				pattern.push(expression)
				index = end + 1
				continue
			}
		}
		buffer += text[index]
		index++
	}
	flush()
	return pattern
}

/** The upstream editor only understands text and simple expressions. Project this view only. */
export function editableVariant(variant: VariantRow): VariantRow {
	const text = patternToEditorText(variant.pattern)
	return { ...variant, pattern: text ? [{ type: "text", value: text }] : [] }
}
