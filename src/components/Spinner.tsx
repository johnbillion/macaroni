export function Spinner({ class: className }: { class?: string }) {
	return (
		<span class={`spinner${className ? ` ${className}` : ""}`} role="img" aria-label="loading" />
	);
}
