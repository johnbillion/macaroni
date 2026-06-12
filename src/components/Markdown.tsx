import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Attachment } from "../state/store";

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
			{copied ? "Copied!" : "Copy"}
		</button>
	);
}

// Code blocks longer than this many lines become scrollable, capped at SCROLL_LINES tall.
// Shorter blocks always render in full.
const SCROLL_THRESHOLD = 30;
const SCROLL_LINES = 20;

function CodeBlock({ children }: { children?: ComponentChildren }) {
	const text = extractText(children);
	const lineCount = text.replace(/\n$/, "").split("\n").length;
	const scrollable = lineCount > SCROLL_THRESHOLD;
	return (
		<pre
			class={scrollable ? "code-block-scroll" : undefined}
			style={scrollable ? { maxHeight: `calc(${SCROLL_LINES} * 1lh + 20px)` } : undefined}
		>
			<CodeCopyButton text={text} />
			{children}
		</pre>
	);
}

function ImageWithControls({ src }: { src?: string; alt?: string; title?: string }) {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	return (
		<span class="markdown-image-wrap">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-zoom is a bonus affordance; the dialog's Close button is keyboard-accessible. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: same reason — click-to-zoom is a bonus on top of the dialog controls. */}
			<img
				src={src}
				alt=""
				loading="lazy"
				class="markdown-image"
				onClick={() => dialogRef.current?.showModal()}
			/>
			<dialog ref={dialogRef} class="app-dialog markdown-image-dialog">
				<img src={src} alt="" />
				<span class="markdown-image-controls markdown-image-controls-reverse">
					<button
						type="button"
						class="markdown-image-control markdown-image-control-close"
						aria-label="Close"
						onClick={() => dialogRef.current?.close()}
					>
						×
					</button>
				</span>
			</dialog>
		</span>
	);
}

// Escape characters that would otherwise be interpreted as markdown syntax inside the
// alt-text / link-text we generate when substituting {F<id>} tokens.
function escapeForMarkdownText(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (m) => `\\${m}`);
}

function substituteAttachmentTokens(source: string, attachments: Attachment[]): string {
	if (attachments.length === 0) return source;
	const byId = new Map(attachments.map((a) => [a.id, a]));
	return source.replace(/\{F(\d+)\}/g, (match, id: string) => {
		const a = byId.get(id);
		if (!a) return match;
		const isImage = (a.content_type ?? "").startsWith("image/");
		const text = escapeForMarkdownText(a.file_name);
		return isImage ? `![${text}](${a.expiring_url})` : `[${text}](${a.expiring_url})`;
	});
}

// Comments sometimes contain root-relative (`/reports/123`) or protocol-relative
// (`//example.com`) URLs. Normalise them to absolute links so they open correctly from
// the Tauri webview; root-relative URLs are anchored to HackerOne. Anything that isn't an
// http(s) link after normalisation (e.g. `mailto:`, `tel:`, in-page `#anchors`, bare
// relative paths) is stripped and rendered as inline code rather than a clickable link.
const HACKERONE_BASE = "https://hackerone.com";

// Returns the absolute http(s) URL to link to, or null if the href should be stripped.
function resolveHref(href: string): string | null {
	let resolved = href;
	if (href.startsWith("//")) {
		// Protocol-relative.
		resolved = `https:${href}`;
	} else if (href.startsWith("/")) {
		// Root-relative — anchor to HackerOne.
		resolved = `${HACKERONE_BASE}${href}`;
	}
	return /^https?:\/\//i.test(resolved) ? resolved : null;
}

// react-markdown's `Components` type is typed against React; cast through to keep Preact JSX happy.
const components = {
	pre: ({ children }: { children?: ComponentChildren }) => <CodeBlock>{children}</CodeBlock>,
	img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => (
		<ImageWithControls src={src} alt={alt} title={title} />
	),
	a: ({ href, children }: { href?: string; children?: ComponentChildren }) => {
		const resolved = href ? resolveHref(href) : null;
		// Non-http(s) links are stripped: keep the visible text but render it as inert code.
		if (!resolved) return <code>{children}</code>;
		return (
			<a
				href={resolved}
				target="_blank"
				rel="noopener noreferrer"
				onClick={(e) => {
					e.preventDefault();
					openUrl(resolved);
				}}
			>
				{children}
			</a>
		);
	},
	// biome-ignore lint/suspicious/noExplicitAny: react-markdown components map uses React types
} as any;

export function Markdown({
	source,
	attachments,
	class: className,
}: {
	source: string;
	attachments?: Attachment[];
	class?: string;
}) {
	const rendered = useMemo(
		() => substituteAttachmentTokens(source, attachments ?? []),
		[source, attachments],
	);
	return (
		<div class={`markdown${className ? ` ${className}` : ""}`}>
			<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
				{rendered}
			</ReactMarkdown>
		</div>
	);
}
