/**
 * Stands in for `@lix-js/sdk` in the editor webview.
 *
 * The editor only uses the SDK's pure helpers (checks, selector rules, types). The extension owns
 * the project, so the webview never opens a Lix. Without this stub, the bundle would ship the Lix
 * engine (an ~80 MB WASM file and its workers) that the webview never loads.
 */
const unavailable = () => {
	throw new Error("Lix is not available in the Sherlock editor webview.")
}

export const openLix = unavailable
export const Value = { jsonb: unavailable }
