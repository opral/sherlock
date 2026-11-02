import "./App.css"
import { useEffect, useState } from "react"
import { vscode } from "./utils/vscode.js"
import Editor from "./components/Editor.js"
import type { BundleNested, ProjectSettings } from "@inlang/sdk"

type VscodeMessage = {
	command: "change"
	reset?: boolean
	data: {
		bundle: BundleNested | undefined
		settings: ProjectSettings
	}
}

function App() {
	const [data, setData] = useState<VscodeMessage["data"]>()
	// counts the times the extension asked to show the stored text again (after a failed save)
	const [resetKey, setResetKey] = useState(0)

	useEffect(() => {
		const unsubscribe = vscode.onMessage((message: unknown) => {
			if (!message || typeof message !== "object" || !("command" in message)) return
			if (message.command !== "change" || !("data" in message)) return
			const data = message.data
			if (!data || typeof data !== "object" || !("bundle" in data) || !("settings" in data)) return
			if (
				data.bundle !== undefined &&
				data.bundle !== null &&
				(typeof data.bundle !== "object" ||
					!("messages" in data.bundle) ||
					!Array.isArray(data.bundle.messages))
			)
				return
			if (
				!data.settings ||
				typeof data.settings !== "object" ||
				!("locales" in data.settings) ||
				!Array.isArray(data.settings.locales)
			)
				return
			const typedMessage = message as VscodeMessage
			setData(typedMessage.data)
			if (typedMessage.reset) setResetKey((key) => key + 1)
		})
		// ask for the data: what the extension posted before this listener existed is lost
		vscode.postMessage({ command: "ready" })
		return unsubscribe
	}, [])

	if (!data) return <p className="status">Loading…</p>
	if (!data.bundle) return <p className="status">This message no longer exists.</p>
	return <Editor bundle={data.bundle} settings={data.settings} resetKey={resetKey} />
}

export default App
