import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import type { Attachment } from "../state/store";

function suggestedFilename(src: string, alt?: string): string {
	if (alt?.trim()) return alt.trim();
	try {
		const last = new URL(src).pathname.split("/").pop();
		if (last) return decodeURIComponent(last);
	} catch {}
	return "image";
}

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

function ImageWithControls({ src, alt }: { src?: string; alt?: string; title?: string }) {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const handleDownload = async () => {
		if (!src) return;
		try {
			await api.saveAttachment(src, suggestedFilename(src, alt));
		} catch (e) {
			console.error("[image-download] failed", e);
		}
	};
	return (
		<span class="markdown-image-wrap">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the MAX button next to this image is the keyboard-accessible affordance for opening the dialog. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: same reason — click-to-zoom is a bonus on top of the explicit MAX button. */}
			<img
				src={src}
				alt=""
				loading="lazy"
				class="markdown-image"
				onClick={() => dialogRef.current?.showModal()}
			/>
			<span class="markdown-image-controls">
				<button type="button" class="markdown-image-control" onClick={handleDownload}>
					DOWNLOAD
				</button>
				<button
					type="button"
					class="markdown-image-control markdown-image-control-icon"
					aria-label="Maximize"
					onClick={() => dialogRef.current?.showModal()}
				>
					<svg viewBox="0 0 12 12" aria-hidden="true">
						<title>Maximize</title>
						<path d="M2 5V2h3" fill="none" stroke="currentColor" stroke-width="1.5" />
						<path d="M10 5V2H7" fill="none" stroke="currentColor" stroke-width="1.5" />
						<path d="M2 7v3h3" fill="none" stroke="currentColor" stroke-width="1.5" />
						<path d="M10 7v3H7" fill="none" stroke="currentColor" stroke-width="1.5" />
					</svg>
				</button>
			</span>
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
					<button type="button" class="markdown-image-control" onClick={handleDownload}>
						DOWNLOAD
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

// react-markdown's `Components` type is typed against React; cast through to keep Preact JSX happy.
const components = {
	pre: ({ children }: { children?: ComponentChildren }) => (
		<pre>
			<CodeCopyButton text={extractText(children)} />
			{children}
		</pre>
	),
	img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => (
		<ImageWithControls src={src} alt={alt} title={title} />
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
