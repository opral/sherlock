import { useLayoutEffect, useRef } from "react"
import {
	InlangMessageForms,
	InlangPatternEditor,
	type AddVariantEventDetail,
	type ChangeEventDetail,
	type SelectVariantEventDetail,
} from "@inlang/editor-component"
import type { BundleNested, Pattern } from "@inlang/sdk"

export type EditorMessage = BundleNested["messages"][number]
export type EditorVariant = EditorMessage["variants"][number]
export type Declarations = BundleNested["declarations"]

/**
 * `<inlang-pattern-editor>` for one variant. The editor reports every edit; the variant is only
 * passed again when its text changed elsewhere, so that a re-render never replaces what is typed.
 */
export function PatternField({
	variant,
	declarations,
	label,
	placeholder,
	fields,
	onChange,
	onBlur,
}: {
	variant: EditorVariant
	declarations: Declarations
	label: string
	placeholder: string
	/** the pattern editors by variant id, to focus a form that was just added */
	fields: Map<string, InlangPatternEditor>
	onChange: (variantId: string, pattern: Pattern) => void
	onBlur: () => void
}) {
	const host = useRef<HTMLDivElement>(null)
	const editor = useRef<InlangPatternEditor>(undefined)
	const given = useRef<string>(undefined)
	const callbacks = useRef({ onChange, onBlur })
	callbacks.current = { onChange, onBlur }

	useLayoutEffect(() => {
		const element = new InlangPatternEditor()
		element.addEventListener("change", (event) => {
			event.stopPropagation()
			const detail = (event as CustomEvent<ChangeEventDetail>).detail
			const edited = detail.newData as EditorVariant | undefined
			if (!edited) return
			given.current = JSON.stringify(edited.pattern)
			callbacks.current.onChange(detail.entityId, edited.pattern)
		})
		element.addEventListener("pattern-editor-blur", () => callbacks.current.onBlur())
		host.current!.append(element)
		editor.current = element
		fields.set(variant.id, element)
		return () => {
			if (fields.get(variant.id) === element) fields.delete(variant.id)
			element.remove()
		}
		// one element per variant: the parent keys the field by variant id
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	useLayoutEffect(() => {
		const element = editor.current!
		element.setAttribute("aria-label", label)
		element.placeholder = placeholder
		element.declarations = declarations
		element.variables = declarations.map((declaration) => ({ name: declaration.name }))
		const text = JSON.stringify(variant.pattern)
		if (text === given.current) return
		given.current = text
		element.variant = variant
	}, [variant, declarations, label, placeholder])

	return <div ref={host} className="field" />
}

/** `<inlang-message-forms>`: the forms (plural, select, …) of a message, to pick the one to edit. */
export function MessageForms({
	message,
	declarations,
	referenceVariants,
	selectedVariantId,
	onSelect,
	onAdd,
}: {
	message: EditorMessage
	declarations: Declarations
	referenceVariants: EditorVariant[] | undefined
	selectedVariantId: string
	onSelect: (variantId: string) => void
	onAdd: (matches: EditorVariant["matches"]) => void
}) {
	const host = useRef<HTMLDivElement>(null)
	const forms = useRef<InlangMessageForms>(undefined)
	const callbacks = useRef({ onSelect, onAdd })
	callbacks.current = { onSelect, onAdd }

	useLayoutEffect(() => {
		const element = new InlangMessageForms()
		element.addEventListener("select-variant", (event) =>
			callbacks.current.onSelect((event as CustomEvent<SelectVariantEventDetail>).detail.variantId)
		)
		element.addEventListener("add-variant", (event) =>
			callbacks.current.onAdd(
				(event as CustomEvent<AddVariantEventDetail>).detail.matches as EditorVariant["matches"]
			)
		)
		host.current!.append(element)
		forms.current = element
		return () => element.remove()
	}, [])

	useLayoutEffect(() => {
		const element = forms.current!
		element.message = message
		element.variants = message.variants
		element.declarations = declarations
		element.referenceVariants = referenceVariants
		element.locale = message.locale
		element.selectedVariantId = selectedVariantId
	}, [message, declarations, referenceVariants, selectedVariantId])

	return <div ref={host} className="forms" />
}
