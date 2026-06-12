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
// (`//example.com`) URLs. Resolve them to absolute links so they open correctly from
// the Tauri webview; root-relative URLs are anchored to HackerOne.
const HACKERONE_BASE = "https://hackerone.com";

function resolveHref(href: string): { href: string; isExternal: boolean } {
	if (href.startsWith("#")) return { href, isExternal: false };
	// Already absolute, e.g. https:, mailto:.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href, isExternal: true };
	// Protocol-relative.
	if (href.startsWith("//")) return { href: `https:${href}`, isExternal: true };
	// Root-relative — anchor to HackerOne.
	if (href.startsWith("/")) return { href: `${HACKERONE_BASE}${href}`, isExternal: true };
	return { href, isExternal: false };
}

// react-markdown's `Components` type is typed against React; cast through to keep Preact JSX happy.
const components = {
	pre: ({ children }: { children?: ComponentChildren }) => <CodeBlock>{children}</CodeBlock>,
	img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => (
		<ImageWithControls src={src} alt={alt} title={title} />
	),
	a: ({ href, children }: { href?: string; children?: ComponentChildren }) => {
		const { href: resolvedHref, isExternal } = href
			? resolveHref(href)
			: { href: undefined, isExternal: false };
		return (
			<a
				href={resolvedHref}
				target={isExternal ? "_blank" : undefined}
				rel={isExternal ? "noopener noreferrer" : undefined}
				onClick={
					isExternal && resolvedHref
						? (e) => {
								e.preventDefault();
								openUrl(resolvedHref);
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
