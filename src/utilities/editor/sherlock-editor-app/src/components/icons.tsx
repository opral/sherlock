/** Small inline icons (webviews have no codicon font), drawn in the current text color. */
const paths = {
	// codicon "warning"
	warning:
		"M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28 2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z",
	// codicon "trash"
	trash:
		"M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z",
	// codicon "close"
	close:
		"M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z",
	// codicon "sparkle"
	sparkle:
		"M5.4 1.2 6 3.6l2.4.6L6 4.8 5.4 7.2 4.8 4.8 2.4 4.2l2.4-.6.6-2.4zm5.6 4.3.9 3.1 3.1.9-3.1.9-.9 3.1-.9-3.1-3.1-.9 3.1-.9.9-3.1zM4 10l.45 1.55L6 12l-1.55.45L4 14l-.45-1.55L2 12l1.55-.45L4 10z",
} as const

export function Icon({ name }: { name: keyof typeof paths }) {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={paths[name]} />
		</svg>
	)
}
