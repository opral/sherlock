import "./App.css"
import { useEffect, useState } from "react"
import { vscode } from "./utils/vscode.js"
import Editor from "./components/Editor.js"
import type { BundleNested, ProjectSettings } from "@inlang/sdk"

type VscodeMessage = {
	command: "change"
	data: {
		bundle: BundleNested | undefined
		settings: ProjectSettings
	}
}

function App() {
	const [data, setData] = useState<VscodeMessage["data"]>()

	useEffect(() => {
		const unsubscribe = vscode.onMessage((message: unknown) => {
			const typedMessage = message as VscodeMessage
			if (typedMessage?.command !== "change") return
			setData(typedMessage.data)
		})
		// ask for the data: what the extension posted before this listener existed is lost
		vscode.postMessage({ command: "ready" })
		return unsubscribe
	}, [])

	if (!data) return <p className="status">Loading…</p>
	if (!data.bundle) return <p className="status">This message no longer exists.</p>
	return <Editor bundle={data.bundle} settings={data.settings} />
}

export default App
