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
			const typedMessage = message as VscodeMessage
			if (typedMessage?.command !== "change") return
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
