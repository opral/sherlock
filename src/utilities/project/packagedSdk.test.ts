import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { build } from "esbuild"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const require = createRequire(import.meta.url)

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true }))
	)
})

describe("packaged SDK", () => {
	it("loads a project with the packaged Lix worker and WASM fallback", async () => {
		const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-packaged-sdk-"))
		temporaryDirectories.push(bundleDirectory)
		const loaderEntry = path.join(bundleDirectory, "project-loader-source.js")
		const inlangSdkEntry = require.resolve("@inlang/sdk")
		const inlangSdkRequire = createRequire(inlangSdkEntry)
		const lixSdkDist = path.dirname(inlangSdkRequire.resolve("@lix-js/sdk"))

		await fs.writeFile(path.join(bundleDirectory, "package.json"), '{"type":"module"}')
		await fs.writeFile(
			loaderEntry,
			`
				import fs from "node:fs"
				import { loadProjectFromDirectory } from ${JSON.stringify(inlangSdkEntry)}
				const project = await loadProjectFromDirectory({ path: process.argv[2], fs })
				console.log(JSON.stringify((await project.settings.get()).locales))
				await project.close()
			`
		)

		await build({
			entryPoints: [
				{ in: loaderEntry, out: "project-loader" },
				{ in: path.join(lixSdkDist, "worker/entry.node.js"), out: "entry.node" },
			],
			bundle: true,
			format: "esm",
			banner: {
				js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
			},
			platform: "node",
			outdir: bundleDirectory,
		})
		await fs.mkdir(path.join(bundleDirectory, "wasm"))
		await fs.copyFile(
			path.join(lixSdkDist, "wasm/lix_js_sdk_bg.wasm"),
			path.join(bundleDirectory, "wasm/lix_js_sdk_bg.wasm")
		)

		const projectPath = path.join(process.cwd(), "examples/minimal/project.inlang")
		const { stdout } = await execFileAsync(process.execPath, [
			"--expose-gc",
			path.join(bundleDirectory, "project-loader.js"),
			projectPath,
		])

		expect(JSON.parse(stdout.trim())).toEqual(["en", "de"])
	})
})
