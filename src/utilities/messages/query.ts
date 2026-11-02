import type { Message, Pattern } from "@inlang/sdk"
import { patternToText, textToPattern } from "./pattern.js"

export const getStringFromPattern = (args: {
	pattern: Pattern
	locale: string
	messageId: Message["id"]
}): string => patternToText(args.pattern)

export const getPatternFromString = (args: {
	string: string
	previousPattern?: Pattern
}): Pattern => textToPattern(args.string, args.previousPattern)
