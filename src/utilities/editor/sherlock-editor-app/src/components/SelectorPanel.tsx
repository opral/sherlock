import { useState } from "react"
import {
	addExactNumber,
	addSelectValue,
	addSelector,
	removeExactNumber,
	removeSelectValue,
	removeSelector,
	selectableVariables,
	type SelectorKind,
} from "@inlang/editor-component"
import { isNumericKey, selectorGroups } from "@inlang/sdk/browser"
import type { BundleNested } from "@inlang/sdk"
import { Icon } from "./icons.js"

/**
 * "Plural & select": what the translations of a message are chosen by. Every change applies to
 * all languages (the editor component's pure bundle helpers); new forms are created empty in the
 * reference language, and the other languages get "+ Add form" for them.
 */
export function SelectorPanel({
	bundle,
	referenceLocale,
	createId,
	onChange,
	onError,
}: {
	bundle: BundleNested
	referenceLocale: string
	createId: () => string
	onChange: (next: BundleNested) => void
	onError: (message: string) => void
}) {
	const [variable, setVariable] = useState("")
	const [kind, setKind] = useState<SelectorKind>("plural")
	const [values, setValues] = useState("")
	const [newValue, setNewValue] = useState<Record<string, string>>({})

	const reference = bundle.messages.find((message) => message.locale === referenceLocale)
	const groups = reference ? selectorGroups(reference, bundle.declarations) : []
	const candidates = selectableVariables(bundle)
	const chosen = candidates.includes(variable) ? variable : (candidates[0] ?? "")

	const apply = (change: () => BundleNested) => {
		try {
			onChange(change())
			return true
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error))
			return false
		}
	}

	return (
		<section className="selectors" aria-label="Plural and select">
			{groups.length > 0 && (
				<ul className="selector-list">
					{groups.map((group) => {
						const exactNumbers = group.exactSelector
							? group.keys.filter((key) => isNumericKey(key))
							: []
						const selectValues = group.isPlural ? [] : group.keys.filter((key) => key !== "*")
						const inputKey = group.selector
						return (
							<li key={group.selector} className="selector">
								<div className="selector-head">
									<span className="token">{`{${group.input}}`}</span>
									<span className="selector-kind">
										{group.isPlural
											? group.plural?.type === "ordinal"
												? "ordinal"
												: "plural"
											: "select"}
									</span>
									<button
										type="button"
										className="icon-button"
										title={`Remove the choice by {${group.input}} in every language (keeps the "other" form)`}
										aria-label={`Remove the choice by ${group.input}`}
										onClick={() => apply(() => removeSelector(bundle, group.selector))}
									>
										<Icon name="close" />
									</button>
								</div>
								<div className="selector-values">
									{(group.isPlural ? exactNumbers : selectValues).map((value) => (
										<span key={value} className="chip">
											{group.isPlural ? `=${value}` : value}
											<button
												type="button"
												className="chip-remove"
												aria-label={`Remove ${value} in every language`}
												title="Remove this form in every language"
												onClick={() =>
													apply(() =>
														group.isPlural
															? removeExactNumber(bundle, { selector: group.selector, value })
															: removeSelectValue(bundle, { selector: group.selector, value })
													)
												}
											>
												<Icon name="close" />
											</button>
										</span>
									))}
									<form
										className="inline-form"
										onSubmit={(event) => {
											event.preventDefault()
											const value = (newValue[inputKey] ?? "").trim()
											if (!value) return
											const added = apply(() =>
												group.isPlural
													? addExactNumber(bundle, {
															selector: group.selector,
															value,
															locale: referenceLocale,
															createId,
														})
													: addSelectValue(bundle, {
															selector: group.selector,
															value,
															locale: referenceLocale,
															createId,
														})
											)
											if (added) setNewValue((all) => ({ ...all, [inputKey]: "" }))
										}}
									>
										<input
											className="input input-small"
											value={newValue[inputKey] ?? ""}
											onChange={(event) =>
												setNewValue((all) => ({ ...all, [inputKey]: event.target.value }))
											}
											placeholder={group.isPlural ? "Exact number, e.g. 0" : "Value, e.g. diverse"}
											aria-label={
												group.isPlural
													? `Add an exact number for ${group.input}`
													: `Add a value of ${group.input}`
											}
											inputMode={group.isPlural ? "decimal" : undefined}
										/>
										<button type="submit" className="button-secondary">
											Add
										</button>
									</form>
								</div>
							</li>
						)
					})}
				</ul>
			)}
			{candidates.length > 0 ? (
				<form
					className="add-selector"
					onSubmit={(event) => {
						event.preventDefault()
						const list = values
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean)
						const added = apply(() =>
							addSelector(bundle, {
								variable: chosen,
								kind,
								values: kind === "select" ? list : undefined,
								locale: referenceLocale,
								createId,
							})
						)
						if (added) setValues("")
					}}
				>
					<span className="label">Choose by</span>
					<select
						className="input"
						value={chosen}
						onChange={(event) => setVariable(event.target.value)}
						aria-label="Variable"
					>
						{candidates.map((name) => (
							<option key={name} value={name}>{`{${name}}`}</option>
						))}
					</select>
					<div className="segmented" role="radiogroup" aria-label="Kind">
						{(["plural", "ordinal", "select"] as const).map((value) => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={kind === value}
								className={kind === value ? "segment selected" : "segment"}
								onClick={() => setKind(value)}
								title={
									value === "plural"
										? "A form per plural category of each language (one, few, other, …)"
										: value === "ordinal"
											? "A form per ordinal category (1st, 2nd, 3rd, …)"
											: "A form per value of the variable (e.g. female, male)"
								}
							>
								{value === "plural" ? "Plural" : value === "ordinal" ? "Ordinal" : "Select"}
							</button>
						))}
					</div>
					{kind === "select" && (
						<input
							className="input"
							value={values}
							onChange={(event) => setValues(event.target.value)}
							placeholder="Values, e.g. female, male"
							aria-label="Values"
						/>
					)}
					<button type="submit" className="button-secondary">
						Add
					</button>
				</form>
			) : (
				<p className="hint">
					{groups.length > 0
						? "Every variable of this message is used already."
						: "This message has no variable to choose by. Type one into the text, e.g. {count}, then make it plural."}
				</p>
			)}
		</section>
	)
}
