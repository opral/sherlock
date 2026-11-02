// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { InlangPatternEditor } from "@inlang/editor-component"
import { PatternField, type EditorVariant } from "./fields.js"
import Editor from "./Editor.js"
import { vscode } from "../utils/vscode.js"

describe("native pattern field AST and lifecycle", () => {
	let root: Root
	let container: HTMLDivElement
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
		container = document.createElement("div")
		document.body.append(container)
		root = createRoot(container)
	})
	afterEach(async () => {
		await act(async () => root.unmount())
		container.remove()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	async function mount(pattern: EditorVariant["pattern"]) {
		const fields = new Map<string, InlangPatternEditor>()
		const onChange = vi.fn(),
			onBlur = vi.fn()
		const props = {
			variant: { id: "v", message_id: "m", matches: [], pattern } as EditorVariant,
			declarations: [],
			label: "English",
			placeholder: "Translate",
			fields,
			onChange,
			onBlur,
		}
		const render = async () => {
			await act(async () => {
				root.render(<PatternField {...props} />)
				await fields.get("v")?.updateComplete
			})
			await fields.get("v")!.updateComplete
		}
		await render()
		return { props, fields, onChange, onBlur, render, element: fields.get("v")! }
	}

	function replaceFirstText(element: InlangPatternEditor, text: string) {
		const state = element.editor.getEditorState().toJSON()
		const block = state.root.children[0] as unknown as {
			children: Array<{ type: string; text?: string }>
		}
		const node = block.children.find((node) => node.type === "text")!
		node.text = text
		element.editor.setEditorState(element.editor.parseEditorState(state))
	}

	it("keeps native markup, annotated and literal tokens, literal braces, and newlines through edits", async () => {
		const pattern: EditorVariant["pattern"] = [
			{ type: "text", value: "literal {name}\n" },
			{
				type: "markup-start",
				name: "a",
				options: [{ name: "href", value: { type: "literal", value: "https://example.com" } }],
			},
			{
				type: "expression",
				arg: { type: "variable-reference", name: "count" },
				annotation: {
					type: "function-reference",
					name: "number",
					options: [{ name: "minimumFractionDigits", value: { type: "literal", value: "2" } }],
				},
			},
			{ type: "expression", arg: { type: "literal", value: "count" } },
			{ type: "markup-end", name: "a", options: [] },
			{ type: "text", value: "\n" },
		]
		const { element, onChange } = await mount(pattern)
		expect(onChange).not.toHaveBeenCalled()
		expect(element.variant.pattern).toEqual(pattern)
		expect(element.querySelectorAll("[data-inlang-token]").length).toBe(4)
		await act(async () => replaceFirstText(element, "changed literal {name}"))
		const expected = structuredClone(pattern)
		;(expected[0] as { value: string }).value = "changed literal {name}\n"
		expect(onChange).toHaveBeenCalledExactlyOnceWith("v", expected)
	})

	it("retains typed source on local rerenders and ignores programmatic updates", async () => {
		const { element, onChange, props, render } = await mount([{ type: "text", value: "before" }])
		await act(async () => replaceFirstText(element, "after\n"))
		expect(onChange).toHaveBeenCalledOnce()
		const assigned = element.variant
		props.variant = { ...props.variant, pattern: onChange.mock.calls[0]![1] }
		await render()
		expect(element.variant).toBe(assigned)
		expect(onChange).toHaveBeenCalledOnce()
		props.variant = { ...props.variant, pattern: [{ type: "text", value: "external {literal}\n" }] }
		await render()
		expect(element.variant.pattern).toEqual(props.variant.pattern)
		expect(onChange).toHaveBeenCalledOnce()
	})

	it("sends typed tags around a variable as the native AST", async () => {
		const { element, onChange } = await mount([
			{ type: "text", value: "before" },
			{ type: "expression", arg: { type: "variable-reference", name: "name" } },
		])
		await act(async () => {
			const state = element.editor.getEditorState().toJSON()
			const block = state.root.children[0] as unknown as {
				children: Array<{ type: string; text?: string }>
			}
			block.children[0]!.text = "<b>"
			block.children.push({ ...block.children[0]!, text: "</b>\n" })
			element.editor.setEditorState(element.editor.parseEditorState(state))
		})
		expect(onChange).toHaveBeenCalledOnce()
		const [, pattern] = onChange.mock.calls[0]!
		expect(pattern).toEqual([
			{ type: "text", value: "<b>" },
			{ type: "expression", arg: { type: "variable-reference", name: "name" } },
			{ type: "text", value: "</b>\n" },
		])
	})

	it("removes field callbacks and registry ownership on unmount", async () => {
		const { element, fields, onChange, onBlur, props } = await mount([])
		await act(async () => root.render(null))
		expect(fields.size).toBe(0)
		element.dispatchEvent(
			new CustomEvent("change", {
				detail: {
					entityId: "v",
					newData: { ...props.variant, pattern: [{ type: "text", value: "detached" }] },
				},
			})
		)
		element.dispatchEvent(new CustomEvent("pattern-editor-blur"))
		expect(onChange).not.toHaveBeenCalled()
		expect(onBlur).not.toHaveBeenCalled()
	})

	it("batches the edited AST and its intent ID in the host protocol", async () => {
		const post = vi.spyOn(vscode, "postMessage")
		const variant: EditorVariant = {
			id: "v",
			message_id: "m",
			matches: [],
			pattern: [{ type: "text", value: "before" }],
		}
		await act(async () =>
			root.render(
				<Editor
					bundle={{
						id: "hello",
						declarations: [],
						messages: [
							{ id: "m", bundle_id: "hello", locale: "en-US", selectors: [], variants: [variant] },
						],
					}}
					settings={{ baseLocale: "en-US", locales: ["en-US"], modules: [] }}
				/>
			)
		)
		const element = container.querySelector("inlang-pattern-editor") as InlangPatternEditor
		await element.updateComplete
		expect(post).not.toHaveBeenCalled()
		await act(async () => replaceFirstText(element, "literal {name}\n"))
		expect(post).toHaveBeenCalledOnce()
		expect(post.mock.calls[0]![0]).toMatchObject({
			command: "apply-changes",
			persist: false,
			patternEdits: ["v"],
			changes: [
				{
					entity: "variant",
					entityId: "v",
					newData: {
						pattern: [{ type: "text", value: "literal {name}\n" }],
					},
				},
			],
		})
		expect(post.mock.calls[0]![0]).not.toHaveProperty("patternTexts")
	})
})
