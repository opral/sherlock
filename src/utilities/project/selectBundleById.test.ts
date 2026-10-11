import { describe, expect, it, vi } from "vitest"
import { selectBundleNested } from "@inlang/sdk"
import { selectBundleById } from "./selectBundleById.js"

vi.mock("@inlang/sdk", () => ({
	selectBundleNested: vi.fn(),
}))

describe("selectBundleById", () => {
	it("queries the explicit project's bundle id", async () => {
		const executeTakeFirst = vi.fn(async () => ({ id: "welcome" }))
		const where = vi.fn(() => ({ executeTakeFirst }))
		vi.mocked(selectBundleNested).mockReturnValue({ where } as any)
		const project = { db: {} }

		await expect(selectBundleById(project as any, "welcome")).resolves.toEqual({
			id: "welcome",
		})
		expect(selectBundleNested).toHaveBeenCalledWith(project.db)
		expect(where).toHaveBeenCalledWith("inlang_bundle.id", "=", "welcome")
	})
})
