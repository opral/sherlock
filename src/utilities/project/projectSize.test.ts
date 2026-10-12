import { describe, expect, it, vi } from "vitest"
import type { InlangProject } from "@inlang/sdk"
import { getProjectSize } from "./projectSize.js"

function fakeProject(args: { count: unknown; settings: unknown }) {
	const executeTakeFirst = vi.fn(async () =>
		args.count === undefined ? undefined : { count: args.count }
	)
	const select = vi.fn(() => ({ executeTakeFirst }))
	const selectFrom = vi.fn(() => ({ select }))
	return {
		project: {
			db: { selectFrom },
			settings: { get: vi.fn(async () => args.settings) },
		} as unknown as InlangProject,
		selectFrom,
	}
}

describe("getProjectSize", () => {
	it("counts the bundles with a count query, not by loading them", async () => {
		const { project, selectFrom } = fakeProject({
			count: 42,
			settings: { baseLocale: "en", locales: ["en", "de", "fr"] },
		})

		expect(await getProjectSize(project)).toEqual({ messageCount: 42, languageCount: 3 })
		expect(selectFrom).toHaveBeenCalledOnce()
		expect(selectFrom).toHaveBeenCalledWith("inlang_bundle")
	})

	it.each([
		["a string", "7", 7],
		["a bigint", 7n, 7],
		["no row", undefined, 0],
	])("normalizes the count when the database returns %s", async (_name, count, expected) => {
		const { project } = fakeProject({ count, settings: { locales: ["en"] } })

		expect((await getProjectSize(project)).messageCount).toBe(expected)
	})

	it("counts no languages for settings without locales", async () => {
		const { project } = fakeProject({ count: 3, settings: { baseLocale: "en" } })

		expect(await getProjectSize(project)).toEqual({ messageCount: 3, languageCount: 0 })
	})
})
