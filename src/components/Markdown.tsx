import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

function extractText(node: unknown): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (typeof node === "object" && "props" in node) {
		return extractText((node as { props: { children?: ComponentChildren } }).props.children);
	}
	return "";
}

function CodeCopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const id = window.setTimeout(() => setCopied(false), 1200);
		return () => window.clearTimeout(id);
	}, [copied]);
	return (
		<button
			type="button"
			class="code-copy"
			title="Copy code"
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
			}}
		>
			{copied ? "COPIED!" : "COPY"}
		</button>
	);
}

// react-markdown's `Components` type is typed against React; cast through to keep Preact JSX happy.
const components = {
	pre: ({ children }: { children?: ComponentChildren }) => (
		<pre>
			<CodeCopyButton text={extractText(children)} />
			{children}
		</pre>
	),
	a: ({ href, children }: { href?: string; children?: ComponentChildren }) => {
		const isExternal = !!href && /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("#");
		return (
			<a
				href={href}
				target={isExternal ? "_blank" : undefined}
				rel={isExternal ? "noopener noreferrer" : undefined}
				onClick={
					isExternal && href
						? (e) => {
								e.preventDefault();
								openUrl(href);
							}
						: undefined
				}
			>
				{children}
			</a>
		);
	},
	// biome-ignore lint/suspicious/noExplicitAny: react-markdown components map uses React types
} as any;

export function Markdown({ source, class: className }: { source: string; class?: string }) {
	return (
		<div class={`markdown${className ? ` ${className}` : ""}`}>
			<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
				{source}
			</ReactMarkdown>
		</div>
	);
}
