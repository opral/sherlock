import * as vscode from "vscode"
import path from "node:path"
import { getNonce } from "../editor/helper/getNonce.js"
import { escapeHtml } from "../utils.js"
import { CLOUD_FEATURES, CLOUD_INTEREST_FORM_URL, machineTranslateCommand } from "./cloudContent.js"
import { getProjectRuntime } from "../project/projectRuntime.js"

export type CloudHintSource = "command" | "editor"

let panel: vscode.WebviewPanel | undefined

/** Opens the interest form in the browser, with "Sherlock" pre-selected. */
export async function openCloudInterestForm() {
	return vscode.env.openExternal(vscode.Uri.parse(CLOUD_INTEREST_FORM_URL))
}

/** The active project's path relative to the workspace folder, for the CLI command. */
function relativeProjectPath() {
	const projectPath = getProjectRuntime().activeProject()?.path
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!projectPath) return undefined
	if (!workspaceFolder) return projectPath
	const relative = path.relative(workspaceFolder, projectPath)
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
		? `./${relative.split(path.sep).join("/")}`
		: projectPath
}

/**
 * "inlang Cloud": hosted AI translation and the other cloud services that are coming, with a
 * button to the interest form, and the inlang CLI for machine translation on your machine today.
 */
export function showCloudPanel(_args: { source: CloudHintSource }) {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active)
		return panel
	}
	panel = vscode.window.createWebviewPanel(
		"sherlockCloud",
		"inlang Cloud",
		vscode.ViewColumn.Active,
		{ enableScripts: true, localResourceRoots: [] }
	)
	const command = machineTranslateCommand(relativeProjectPath())
	panel.webview.html = getCloudHtml({ command, cspSource: panel.webview.cspSource })
	panel.webview.onDidReceiveMessage(async (message: { command?: string }) => {
		switch (message?.command) {
			case "open-form":
				await openCloudInterestForm()
				return
			case "copy-command":
				await vscode.env.clipboard.writeText(command)
				vscode.window.setStatusBarMessage("Copied the inlang CLI command", 3000)
				return
			case "open-terminal": {
				const terminal = vscode.window.createTerminal({
					name: "inlang",
					cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
				})
				terminal.show()
				// typed, not run: the user presses Enter
				terminal.sendText(command, false)
				return
			}
		}
	})
	panel.onDidDispose(() => {
		panel = undefined
	})
	return panel
}

export function getCloudHtml(args: { command: string; cspSource: string }) {
	const nonce = getNonce()
	const csp = [
		`default-src 'none';`,
		`style-src 'nonce-${nonce}';`,
		`script-src 'nonce-${nonce}';`,
	].join(" ")
	const groups = CLOUD_FEATURES.map(
		(group) => `
			<section>
				<h2>${escapeHtml(group.title)}</h2>
				<ul>
					${group.features
						.map(
							(feature) => `
						<li>
							<strong>${escapeHtml(feature.name)}</strong>
							<span>${escapeHtml(feature.description)}</span>
						</li>`
						)
						.join("")}
				</ul>
			</section>`
	).join("")

	return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>inlang Cloud</title>
	<style nonce="${nonce}">
		body {
			margin: 0;
			padding: 24px 28px 40px;
			max-width: 640px;
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			line-height: 1.5;
		}
		h1 { margin: 0; font-size: 20px; font-weight: 600; }
		h1 .soon {
			margin-left: 8px;
			padding: 1px 7px;
			border-radius: 9px;
			font-size: 11px;
			font-weight: 400;
			vertical-align: middle;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.lead { margin: 6px 0 20px; color: var(--vscode-descriptionForeground); }
		h2 {
			margin: 20px 0 6px;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--vscode-descriptionForeground);
		}
		ul { margin: 0; padding: 0; list-style: none; }
		li { display: flex; flex-direction: column; padding: 6px 0; }
		li span { color: var(--vscode-descriptionForeground); }
		button {
			font: inherit;
			height: 28px;
			padding: 0 14px;
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 2px;
			cursor: pointer;
		}
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.primary:hover { background: var(--vscode-button-hoverBackground); }
		.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.cta { margin: 24px 0 8px; }
		.cta p { margin: 0 0 10px; }
		hr { margin: 28px 0 0; border: none; border-top: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border)); }
		code {
			display: block;
			margin: 8px 0 10px;
			padding: 8px 10px;
			border-radius: 2px;
			overflow-x: auto;
			white-space: pre;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size, 12px);
			background: var(--vscode-textCodeBlock-background);
			border: 1px solid var(--vscode-contrastBorder, transparent);
		}
		.actions { display: flex; gap: 8px; flex-wrap: wrap; }
		.note { margin-top: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<h1>inlang Cloud<span class="soon">coming soon</span></h1>
	<p class="lead">Hosted services for your inlang project, from Sherlock, Parrot, Fink and the CLI.</p>
	${groups}
	<div class="cta">
		<p>Tell us what your team needs (it takes a minute):</p>
		<button class="primary" data-command="open-form">Tell us what you need</button>
	</div>
	<hr />
	<h2>Machine translate now, on your machine</h2>
	<p>The inlang CLI translates the missing messages of your project:</p>
	<code>${escapeHtml(args.command)}</code>
	<div class="actions">
		<button class="secondary" data-command="open-terminal" title="Types the command into a new terminal. Press Enter to run it.">Open in terminal</button>
		<button class="secondary" data-command="copy-command">Copy command</button>
	</div>
	<p class="note">By default the CLI uses a free, third-party translation service that inlang doesn't operate. Set your own DeepL or Google Translate API key for more reliability and control.</p>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		for (const button of document.querySelectorAll("button[data-command]")) {
			button.addEventListener("click", () => vscode.postMessage({ command: button.dataset.command }));
		}
	</script>
</body>
</html>`
}
