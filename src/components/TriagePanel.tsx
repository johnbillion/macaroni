import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import { runTriage, stopTriage } from "../state/effects";
import type {
	AppError,
	TriageEvent,
	TriageRecord,
	TriageValidity,
} from "../state/store";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import { TriageWorkingDirField } from "./TriageWorkingDirField";

function formatError(error: AppError): string {
	switch (error.kind) {
		case "unauthorized":
			return "Authentication failed.";
		case "forbidden":
			return "Permission denied.";
		case "rate_limited":
			return "Rate limited.";
		case "network":
			return error.message || "Network error.";
		case "not_found":
			return "Not found.";
		default:
			return error.message || "Unknown error.";
	}
}

export function TriagePanel() {
	const state = useAppState();
	const id = state.selectedReportId;

	if (!id) {
		return <div class="detail-empty">Select a report</div>;
	}

	const detail = state.detail[id];
	const triage = state.triage[id];

	if (!detail || detail.status === "idle" || detail.status === "loading") {
		return <div class="placeholder">Loading report…</div>;
	}
	if (detail.status === "error") {
		return (
			<div class="placeholder error">
				{detail.error.kind}: {detail.error.message}
			</div>
		);
	}

	if (!triage || triage.status === "loading") {
		return <div class="placeholder">Loading triage…</div>;
	}

	const reportTitle = detail.data.title;
	const reportBody = detail.data.vulnerability_information || "(no description)";

	// Triage spawns `claude` in a configured working directory, and there's no default. Until
	// one is set, surface the directory picker here so it can be configured without leaving the
	// triage tab. Any previously-saved analysis still shows below for reference.
	if (!state.triageWorkingDir) {
		const saved =
			triage.status === "ready"
				? triage.result
				: triage.status === "error" || triage.status === "running"
					? triage.saved
					: null;
		return (
			<div class="triage">
				<div class="triage-head">
					<div class="triage-title">AI-assisted triage</div>
					<div class="triage-sub">
						Choose a working directory before running triage — the local checkout where Claude
						investigates the report. You can also set this in Settings.
					</div>
					<TriageWorkingDirField />
				</div>
				{saved ? <AnalysisSection record={saved} heading="Previous analysis" /> : null}
			</div>
		);
	}

	if (triage.status === "running") {
		return <RunningView reportId={id} events={triage.events} saved={triage.saved} />;
	}

	if (triage.status === "ready") {
		return (
			<div class="triage">
				{triage.events.length > 0 ? (
					<details class="triage-events">
						<summary>Run log ({triage.events.length} events)</summary>
						<TriageEventLog events={triage.events} live={false} />
					</details>
				) : null}
				<AnalysisSection record={triage.result} heading="AI-assisted analysis" />
				<PromptEditor
					key={`${id}-ready`}
					reportId={id}
					reportTitle={reportTitle}
					reportBody={reportBody}
					buttonLabel="Re-run"
				/>
			</div>
		);
	}

	if (triage.status === "error") {
		return (
			<div class="triage">
				<PromptEditor
					key={`${id}-error`}
					reportId={id}
					reportTitle={reportTitle}
					reportBody={reportBody}
					subtitle={`Failed: ${formatError(triage.error)}`}
					subtitleClass="triage-error"
					buttonLabel="Retry"
				/>
				{triage.events.length > 0 ? <TriageEventLog events={triage.events} live={false} /> : null}
				{triage.saved ? (
					<AnalysisSection record={triage.saved} heading="Previous analysis" />
				) : null}
			</div>
		);
	}

	return (
		<div class="triage">
			<PromptEditor
				key={`${id}-idle`}
				reportId={id}
				reportTitle={reportTitle}
				reportBody={reportBody}
				subtitle="Review and edit the prompt below before starting the triage."
				buttonLabel="Start triage"
			/>
		</div>
	);
}

function PromptEditor({
	reportId,
	reportTitle,
	reportBody,
	subtitle,
	subtitleClass,
	buttonLabel,
}: {
	reportId: string;
	reportTitle: string;
	reportBody: string;
	subtitle?: string;
	subtitleClass?: string;
	buttonLabel: string;
}) {
	const dispatch = useDispatch();
	const [prompt, setPrompt] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Fetch the assembled default prompt — the parent's `key` prop remounts this component
	// on report change, so the textarea always resets to the current report's default.
	useEffect(() => {
		let cancelled = false;
		api
			.getTriagePrompt(reportTitle, reportBody)
			.then((p) => {
				if (!cancelled) setPrompt(p);
			})
			.catch((e: AppError) => {
				if (!cancelled) setLoadError(e.message || "Failed to load prompt");
			});
		return () => {
			cancelled = true;
		};
	}, [reportTitle, reportBody]);

	const start = () => {
		if (prompt == null) return;
		void runTriage(dispatch, reportId, prompt);
	};

	return (
		<div class="triage-head">
			<div class="triage-title">AI-assisted triage</div>
			<div class={`triage-sub${subtitleClass ? ` ${subtitleClass}` : ""}`}>{subtitle}</div>
			{loadError ? (
				<div class="triage-error">Could not load prompt: {loadError}</div>
			) : prompt == null ? (
				<div class="placeholder">Loading prompt…</div>
			) : (
				<textarea
					class="triage-prompt"
					value={prompt}
					onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
					spellcheck={false}
				/>
			)}
			<button
				type="button"
				class="triage-run"
				onClick={start}
				disabled={prompt == null || prompt.trim().length === 0}
			>
				{buttonLabel}
			</button>
		</div>
	);
}

function RunningView({
	reportId,
	events,
	saved,
}: {
	reportId: string;
	events: TriageEvent[];
	saved: TriageRecord | null;
}) {
	// Local stopping flag — disables the button immediately on click and stays disabled until
	// the run actually finishes (component unmounts when reducer flips state out of "running").
	const [stopping, setStopping] = useState(false);
	const onStop = () => {
		setStopping(true);
		void stopTriage(reportId);
	};
	return (
		<div class="triage">
			<div class="triage-head">
				<div class="triage-title">AI-assisted triage</div>
				<div class="triage-sub">{stopping ? "Stopping…" : "Running… events stream in below."}</div>
				<button type="button" class="triage-run triage-stop" onClick={onStop} disabled={stopping}>
					{stopping ? "Stopping…" : "Stop"}
				</button>
			</div>
			<TriageEventLog events={events} live />
			{saved ? (
				<details class="triage-prev">
					<summary>
						Previous result {saved.validity ? <ValidityBadge validity={saved.validity} /> : null}
					</summary>
					<Markdown source={saved.summary} class="body-text" />
				</details>
			) : null}
		</div>
	);
}

const VALIDITY_LABEL: Record<TriageValidity, string> = {
	valid: "VALID",
	"partially-valid": "PARTIAL",
	invalid: "INVALID",
	indeterminate: "INDETERMINATE",
	none: "NONE",
};

export function ValidityBadge({ validity }: { validity: TriageValidity }) {
	return (
		<span class={`triage-validity triage-validity-${validity}`}>{VALIDITY_LABEL[validity]}</span>
	);
}

function AnalysisSection({
	record,
	heading,
}: {
	record: TriageRecord;
	heading: string;
}) {
	return (
		<>
			<div class="section-h">
				{heading}
			</div>
			<Markdown source={record.summary} class="body-text" />
		</>
	);
}

function TriageEventLog({ events, live }: { events: TriageEvent[]; live: boolean }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!live) return;
		const el = ref.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [events.length, live]);
	return (
		<div class="triage-log" ref={ref}>
			{events.map((e, i) => (
				<TriageEventRow key={i} event={e} />
			))}
			{live && events.length === 0 ? (
				<div class="triage-log-empty">Waiting for first event…</div>
			) : null}
		</div>
	);
}

// Strip MCP prefixes so `mcp__playwright__browser_navigate` shows as `browser_navigate`.
function prettyToolName(name: string): string {
	const stripped = name.replace(/^mcp__[^_]+__/, "");
	return stripped || name;
}

// One-line summary of a tool_use block's `input` — the args the user actually wants to see
// while scanning the log. Falls back to JSON for tools we don't have a custom format for.
// biome-ignore lint/suspicious/noExplicitAny: tool inputs vary in shape per tool
function summarizeToolInput(name: string, input: any): string {
	if (input == null || typeof input !== "object") return "";
	switch (name) {
		case "Bash":
			return String(input.command ?? "");
		case "Read":
		case "Write":
		case "Edit":
		case "NotebookEdit":
			return String(input.file_path ?? input.notebook_path ?? "");
		case "Grep":
			return `${input.pattern ?? ""}${input.path ? ` in ${input.path}` : ""}`;
		case "Glob":
			return String(input.pattern ?? "");
		case "Task":
			return String(input.description ?? input.subagent_type ?? "");
		case "WebFetch":
			return String(input.url ?? "");
		case "WebSearch":
			return String(input.query ?? "");
		case "TodoWrite":
			return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
		default: {
			// MCP and unknown tools — pick the first string-ish value, or a compact JSON dump.
			for (const [k, v] of Object.entries(input)) {
				if (typeof v === "string" && v.length > 0) {
					return `${k}: ${v}`;
				}
			}
			try {
				return JSON.stringify(input);
			} catch {
				return "";
			}
		}
	}
}

// First non-empty line of a tool_result's content, whether it's a plain string or an array
// of content blocks (the stream-json shape varies between tools).
// biome-ignore lint/suspicious/noExplicitAny: tool_result content is heterogeneous
function summarizeToolResult(content: any): string {
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				block.type === "text" &&
				typeof block.text === "string"
			) {
				text = block.text;
				break;
			}
		}
	}
	const trimmed = text.trim();
	if (!trimmed) return "";
	const firstLine = trimmed.split("\n")[0];
	return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

// biome-ignore lint/suspicious/noExplicitAny: payload shapes vary
function isToolResultError(content: any): boolean {
	if (Array.isArray(content)) {
		return content.some(
			(b) => b && typeof b === "object" && (b.is_error === true || b.type === "tool_use_error"),
		);
	}
	return false;
}

function Row({
	kind,
	klass,
	primary,
	secondary,
}: {
	kind: string;
	klass: string;
	primary?: string;
	secondary?: string;
}) {
	return (
		<div class={`triage-event ${klass}`}>
			<span class="triage-event-kind">{kind}</span>
			<span class="triage-event-text">
				{primary ? <span class="triage-event-primary">{primary}</span> : null}
				{secondary ? <span class="triage-event-secondary"> {secondary}</span> : null}
			</span>
		</div>
	);
}

function TriageEventRow({ event }: { event: TriageEvent }) {
	const t = event.type;
	if (t === "system") {
		const subtype = typeof event.subtype === "string" ? event.subtype : "";
		// Stream-json system events carry different payloads per subtype — pull whichever
		// field has actual content (model on init, description/message on task lifecycle).
		const detail =
			typeof event.model === "string"
				? event.model
				: typeof event.description === "string"
					? event.description
					: typeof event.message === "string"
						? event.message
						: typeof event.content === "string"
							? event.content
							: "";
		return <Row kind="SYSTEM" klass="triage-event-system" primary={subtype} secondary={detail} />;
	}
	if (t === "assistant") {
		const content = event.message?.content;
		if (!Array.isArray(content)) {
			return <Row kind="CLAUDE" klass="triage-event-assistant" />;
		}
		return (
			<>
				{content.map(
					(
						// biome-ignore lint/suspicious/noExplicitAny: content blocks vary by type
						block: any,
						i: number,
					) => {
						const key = `${event.message?.id ?? "msg"}-${i}`;
						if (block.type === "text") {
							const text = String(block.text ?? "").trim();
							if (!text) return null;
							return <Row key={key} kind="CLAUDE" klass="triage-event-assistant" primary={text} />;
						}
						if (block.type === "thinking") {
							const text = String(block.thinking ?? "").trim();
							if (!text) return null;
							return <Row key={key} kind="THINK" klass="triage-event-thinking" primary={text} />;
						}
						if (block.type === "tool_use") {
							const name = prettyToolName(String(block.name ?? "(unknown)"));
							const summary = summarizeToolInput(String(block.name ?? ""), block.input);
							return (
								<Row
									key={key}
									kind="TOOL"
									klass="triage-event-tool"
									primary={name}
									secondary={summary}
								/>
							);
						}
						return null;
					},
				)}
			</>
		);
	}
	if (t === "user") {
		// Tool results — pull the first textual line from each result block in the message.
		const content = event.message?.content;
		if (!Array.isArray(content)) {
			return <Row kind="RESULT" klass="triage-event-result" primary="(no content)" />;
		}
		return (
			<>
				{content.map(
					(
						// biome-ignore lint/suspicious/noExplicitAny: tool_result blocks vary
						block: any,
						i: number,
					) => {
						if (!block || block.type !== "tool_result") return null;
						const summary = summarizeToolResult(block.content) || "(empty)";
						const errored = block.is_error === true || isToolResultError(block.content);
						const key = `res-${block.tool_use_id ?? i}`;
						return (
							<Row
								key={key}
								kind={errored ? "ERROR" : "RESULT"}
								klass={errored ? "triage-event-error" : "triage-event-result"}
								primary={summary}
							/>
						);
					},
				)}
			</>
		);
	}
	if (t === "result") {
		const subtype = typeof event.subtype === "string" ? event.subtype : "done";
		const detail =
			typeof event.duration_ms === "number" ? `${Math.round(event.duration_ms / 1000)}s` : "";
		return <Row kind="FINAL" klass="triage-event-final" primary={subtype} secondary={detail} />;
	}
	if (t === "raw") {
		return <Row kind="RAW" klass="triage-event-raw" primary={String(event.line ?? "")} />;
	}
	return <Row kind={t.toUpperCase()} klass="" />;
}

export function TriageDisclosure() {
	const state = useAppState();
	const id = state.selectedReportId;
	const triage = id ? state.triage[id] : undefined;

	// Seed open state from the current triage state, then reset whenever the selected report
	// changes — but leave the user's manual toggle alone within a single report's view.
	const [open, setOpen] = useState<boolean>(false);

	if (!id) return null;

	const running = triage?.status === "running";
	const validity =
		triage?.status === "ready"
			? triage.result.validity
			: triage?.status === "running" || triage?.status === "error"
				? (triage.saved?.validity ?? null)
				: (state.triageValidityByReport[id] ?? "none");

	return (
		<details
			class="section triage-disclosure"
			open={open}
			onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
		>
			<summary class="triage-disclosure-summary">
				<span class="triage-disclosure-label">Triage</span>
				{running ? (
					<Spinner class="triage-disclosure-spinner" />
				) : validity ? (
					<ValidityBadge validity={validity} />
				) : null}
			</summary>
			<div class="triage-disclosure-body">
				<TriagePanel />
			</div>
		</details>
	);
}
