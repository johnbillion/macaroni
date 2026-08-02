import { useEffect, useState } from "preact/hooks";

// Copies `text` to the clipboard and flashes a confirmation label for a moment. The timeout is
// cleared on unmount so a copy immediately before a re-render doesn't set state on a dead node.
export function CopyButton({
	text,
	label,
	copiedLabel = "Copied!",
	title,
	class: className,
}: {
	text: string;
	label: string;
	copiedLabel?: string;
	title?: string;
	class?: string;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const id = window.setTimeout(() => setCopied(false), 1200);
		return () => window.clearTimeout(id);
	}, [copied]);
	return (
		<button
			type="button"
			class={className}
			title={title}
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
			}}
		>
			{copied ? copiedLabel : label}
		</button>
	);
}
