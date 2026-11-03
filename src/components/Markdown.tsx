import { openUrl } from "@tauri-apps/plugin-opener";
import type { Root } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import type { Attachment, ImageDimensions } from "../state/store";
import { pillFor } from "../utils/pill";

// The message's attachments keyed on URL, so the `img` renderer can find the pixel size of an
// image that substituteAttachmentTokens wrote into the markdown as a plain `![alt](url)`.
const AttachmentsByUrlContext = createContext<Map<string, Attachment>>(new Map());

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

// Code blocks longer than this many lines start collapsed to this height, with a toggle.
const COLLAPSE_LINES = 20;

function CodeBlock({ children }: { children?: ComponentChildren }) {
	const text = extractText(children);
	const lineCount = text.replace(/\n$/, "").split("\n").length;
	const collapsible = lineCount > COLLAPSE_LINES;
	const [expanded, setExpanded] = useState(false);
	const collapsed = collapsible && !expanded;
	return (
		<pre
			class={collapsible ? "code-block-collapsible" : undefined}
			style={collapsed ? { maxHeight: `calc(${COLLAPSE_LINES} * 1lh + 20px)` } : undefined}
		>
			<CodeCopyButton text={text} />
			{children}
			{collapsible && (
				<button
					type="button"
					class="code-toggle"
					aria-expanded={expanded}
					onClick={() => setExpanded((v) => !v)}
				>
					{expanded ? "Collapse" : `Show all ${lineCount} lines`}
				</button>
			)}
		</pre>
	);
}

// The width an image of this size takes within the CSS limits on its box, so the box is reserved
// before the image loads. The width/height attributes alone can't do it: once the max-height
// clamps a tall image the attribute width stays put and the image is squashed, so the width is
// scaled down in ratio here instead. The limits are the `--image-max-*` custom properties the
// image's own CSS rule sets.
function reservedWidth({ width, height }: ImageDimensions): string {
	return `width: min(var(--image-max-width), ${width}px, calc(var(--image-max-height) * ${width} / ${height}))`;
}

function ImageWithControls({
	src,
	dimensions,
}: {
	src?: string;
	alt?: string;
	title?: string;
	/** Pixel size, when known; reserves the image's box before it loads. */
	dimensions?: ImageDimensions;
}) {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const sized =
		dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
	const style = sized ? reservedWidth(sized) : undefined;
	return (
		<span class="markdown-image-wrap">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-zoom is a bonus affordance; the dialog's Close button is keyboard-accessible. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: same reason — click-to-zoom is a bonus on top of the dialog controls. */}
			<img
				src={src}
				alt=""
				loading="lazy"
				width={sized?.width}
				height={sized?.height}
				style={style}
				class="markdown-image"
				onClick={() => dialogRef.current?.showModal()}
			/>
			<dialog ref={dialogRef} class="app-dialog markdown-image-dialog">
				<img src={src} alt="" width={sized?.width} height={sized?.height} style={style} />
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

// IDs of attachments referenced inline via {F<id>} tokens, so callers can avoid
// re-displaying attachments that already appear within the rendered body.
export function referencedAttachmentIds(source: string): Set<string> {
	const ids = new Set<string>();
	for (const m of source.matchAll(/\{F(\d+)\}/g)) ids.add(m[1]);
	return ids;
}

// Render attachments that aren't embedded in the message body — images inline
// (with the same click-to-zoom affordance as embedded ones), other files as links.
export function AttachmentGallery({
	attachments,
	class: className,
	media = true,
}: {
	attachments: Attachment[];
	class?: string;
	/** When false, image attachments are listed as file links rather than embedded. */
	media?: boolean;
}) {
	if (attachments.length === 0) return null;
	return (
		<div class={`attachment-gallery${className ? ` ${className}` : ""}`}>
			{attachments.map((a) => {
				const isImage = media && (a.content_type ?? "").startsWith("image/");
				if (isImage) {
					return (
						<ImageWithControls
							key={a.id}
							src={a.expiring_url}
							alt={a.file_name}
							dimensions={a.dimensions}
						/>
					);
				}
				return (
					<a
						key={a.id}
						href={a.expiring_url}
						target="_blank"
						rel="noopener noreferrer"
						class="attachment-file"
						onClick={(e) => {
							e.preventDefault();
							openUrl(a.expiring_url);
						}}
					>
						{a.file_name}
					</a>
				);
			})}
		</div>
	);
}

// Escape characters that would otherwise be interpreted as markdown syntax inside the
// alt-text / link-text we generate when substituting {F<id>} tokens.
function escapeForMarkdownText(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (m) => `\\${m}`);
}

function substituteAttachmentTokens(
	source: string,
	attachments: Attachment[],
	media: boolean,
): string {
	if (attachments.length === 0) return source;
	const byId = new Map(attachments.map((a) => [a.id, a]));
	return source.replace(/\{F(\d+)\}/g, (match, id: string) => {
		const a = byId.get(id);
		if (!a) return match;
		const isImage = media && (a.content_type ?? "").startsWith("image/");
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

// HackerOne report references written inline in comments (`#123456`) are turned into links
// to the report on hackerone.com. Only "naked" references are matched: a `#` not preceded by
// a word character, followed by 6–7 digits not followed by a further digit — so `#`s embedded
// in larger tokens, short numbers like `#1234`, and 8+ digit numbers are left alone.
// `findAndReplace` only rewrites text nodes, and we ignore link parents, so references inside
// code, inline code, and existing links are untouched.
const REPORT_REF_RE = /(?<![\w#])#(\d{6,7})(?!\d)/g;

// A link straight to a report on hackerone.com, as written explicitly in markdown.
const REPORT_URL_RE = /^https:\/\/hackerone\.com\/reports\/(\d+)\/?(?:[?#].*)?$/i;

// The ids of every report a pill could be appended to in `source`: naked `#<id>` references
// that `remarkReportRefs` will link, plus explicit links to a report URL.
function referencedReportIds(source: string): string[] {
	const ids = new Set<string>();
	for (const m of source.matchAll(REPORT_REF_RE)) ids.add(m[1]);
	for (const m of source.matchAll(/hackerone\.com\/reports\/(\d+)/gi)) ids.add(m[1]);
	return [...ids];
}

function remarkReportRefs() {
	return (tree: Root) => {
		findAndReplace(
			tree,
			[
				[
					REPORT_REF_RE,
					(_match: string, id: string) => ({
						type: "link" as const,
						url: `${HACKERONE_BASE}/reports/${id}`,
						// Surfaces as a `data-report-ref` prop on the rendered `<a>`.
						data: { hProperties: { "data-report-ref": id } },
						children: [{ type: "text" as const, value: `#${id}` }],
					}),
				],
			],
			{ ignore: ["link", "linkReference"] },
		);
	};
}

// Report id → current state, for the referenced reports the local mirror knows about.
const ReportStatesContext = createContext<Record<string, string>>({});

function useReportStates(source: string): Record<string, string> {
	const ids = useMemo(() => referencedReportIds(source), [source]);
	const key = ids.join(",");
	const [states, setStates] = useState<Record<string, string>>({});
	useEffect(() => {
		if (ids.length === 0) return;
		let cancelled = false;
		api.listReportStates(ids).then(
			(rows) => {
				if (cancelled) return;
				setStates(Object.fromEntries(rows.map((r) => [r.id, r.state])));
			},
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [key]);
	return states;
}

function ReportRefPill({ id }: { id: string }) {
	const state = useContext(ReportStatesContext)[id];
	if (!state) return null;
	const pill = pillFor(state);
	return <span class={`pill ${pill.className}`}>{pill.label}</span>;
}

// Drops images written as markdown (`![alt](url)`, including the ones substituteAttachmentTokens
// would have produced) from the tree, along with any paragraph that held nothing else, so
// a comment that was only a screenshot leaves no blank line behind. Working on the tree
// rather than the source text keeps image syntax inside code blocks intact.
function remarkStripImages() {
	const strip = (node: { children?: unknown[] }) => {
		if (!Array.isArray(node.children)) return;
		node.children = node.children.filter((child) => {
			const c = child as { type: string; children?: unknown[] };
			if (c.type === "image" || c.type === "imageReference") return false;
			strip(c);
			return !(c.type === "paragraph" && c.children?.length === 0);
		});
	};
	return (tree: Root) => strip(tree);
}

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
	img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => {
		const byUrl = useContext(AttachmentsByUrlContext);
		const dimensions = src ? byUrl.get(src)?.dimensions : undefined;
		return <ImageWithControls src={src} alt={alt} title={title} dimensions={dimensions} />;
	},
	a: ({
		href,
		children,
		"data-report-ref": reportRef,
	}: {
		href?: string;
		children?: ComponentChildren;
		"data-report-ref"?: string;
	}) => {
		const resolved = href ? resolveHref(href) : null;
		// Non-http(s) links are stripped: keep the visible text but render it as inert code.
		if (!resolved) return <code>{children}</code>;
		const reportId = reportRef ?? resolved.match(REPORT_URL_RE)?.[1];
		return (
			<>
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
				{reportId && <ReportRefPill id={reportId} />}
			</>
		);
	},
	// biome-ignore lint/suspicious/noExplicitAny: react-markdown components map uses React types
} as any;

export function Markdown({
	source,
	attachments,
	class: className,
	media = true,
}: {
	source: string;
	attachments?: Attachment[];
	class?: string;
	/** When false, embedded images are stripped and image attachments become plain links. */
	media?: boolean;
}) {
	const rendered = useMemo(
		() => substituteAttachmentTokens(source, attachments ?? [], media),
		[source, attachments, media],
	);
	const byUrl = useMemo(
		() => new Map((attachments ?? []).map((a) => [a.expiring_url, a])),
		[attachments],
	);
	const remarkPlugins = useMemo(
		() =>
			media
				? [remarkGfm, remarkBreaks, remarkReportRefs]
				: [remarkGfm, remarkBreaks, remarkReportRefs, remarkStripImages],
		[media],
	);
	const reportStates = useReportStates(rendered);
	return (
		<ReportStatesContext.Provider value={reportStates}>
			<AttachmentsByUrlContext.Provider value={byUrl}>
				<div class={`markdown${className ? ` ${className}` : ""}`}>
					<ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
						{rendered}
					</ReactMarkdown>
				</div>
			</AttachmentsByUrlContext.Provider>
		</ReportStatesContext.Provider>
	);
}
