/**
 * Report titles are often pasted in from Markdown and arrive wrapped in heading syntax
 * ("## XSS in login"), which renders as literal hashes wherever the title is shown.
 */
export function formatTitle(title: string): string {
	return title.replace(/^[\s#]+/, "").replace(/[\s#]+$/, "");
}
