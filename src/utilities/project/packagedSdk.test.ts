import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { build } from "esbuild"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true }))
	)
})

describe("packaged SDK", () => {
	it("loads a project without dependencies beside the extension bundle", async () => {
		const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-packaged-sdk-"))
		temporaryDirectories.push(bundleDirectory)
		const outfile = path.join(bundleDirectory, "project-loader.cjs")

		await build({
			stdin: {
				contents: `
					const fs = require("node:fs")
					const { loadProjectFromDirectory } = require("@inlang/sdk")
					async function main() {
						const project = await loadProjectFromDirectory({ path: process.argv[2], fs })
						console.log(JSON.stringify((await project.settings.get()).locales))
						await project.close()
					}
					main().catch((error) => { console.error(error); process.exitCode = 1 })
				`,
				loader: "js",
				resolveDir: process.cwd(),
				sourcefile: "project-loader.js",
			},
			bundle: true,
			format: "cjs",
			platform: "node",
			outfile,
		})

		const projectPath = path.join(process.cwd(), "examples/minimal/project.inlang")
		const { stdout } = await execFileAsync(process.execPath, [outfile, projectPath])

		expect(JSON.parse(stdout.trim())).toEqual(["en", "de"])
	})
})
