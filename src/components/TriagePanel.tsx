import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import { deleteTriageFile, runTriage, stopTriage } from "../state/effects";
import type { AppError, TriageEvent, TriageRecord, TriageValidity } from "../state/store";
import { formatTitle } from "../utils/title";
import { CopyButton } from "./CopyButton";
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

function sessionIdFromEvents(events: TriageEvent[]): string | null {
	for (const e of events) {
		if (typeof e.session_id === "string" && e.session_id) return e.session_id;
	}
	return null;
}

// The `claude --resume` invocation for a finished triage run.
function ResumeSession({ sessionId }: { sessionId: string }) {
	const [command, setCommand] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.triageResumeCommand(sessionId).then(
			(c) => {
				if (!cancelled) setCommand(c);
			},
			// The only failure is an unset working directory, in which case there's nothing
			// useful to show and the section stays hidden.
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	if (command == null) return null;

	return (
		<div class="triage-resume">
			<div class="triage-resume-label">Resume this triage session in a terminal:</div>
			<div class="triage-resume-row">
				<code class="triage-resume-command">{command}</code>
				<CopyButton
					text={command}
					label="Copy"
					class="triage-resume-copy"
					title="Copy the resume command"
				/>
			</div>
		</div>
	);
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

	const reportTitle = formatTitle(detail.data.title);
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
				{saved ? (
					<AnalysisSection record={saved} heading="Previous analysis" reportId={id} />
				) : null}
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
				<AnalysisSection record={triage.result} heading="AI-assisted analysis" reportId={id} />
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
		// A failed run saves no record, so take the session id straight from the event stream.
		const failedSession = sessionIdFromEvents(triage.events);
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
				{failedSession ? <ResumeSession sessionId={failedSession} /> : null}
				{triage.events.length > 0 ? <TriageEventLog events={triage.events} live={false} /> : null}
				{triage.saved ? (
					<AnalysisSection record={triage.saved} heading="Previous analysis" reportId={id} />
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
	reportId,
}: {
	record: TriageRecord;
	heading: string;
	reportId: string;
}) {
	return (
		<>
			<div class="section-h">{heading}</div>
			<Markdown source={record.summary} class="body-text" />
			<NewFilesSection reportId={reportId} files={record.new_files} />
			{record.session_id ? <ResumeSession sessionId={record.session_id} /> : null}
		</>
	);
}

// Lists the files claude wrote during the run, each with a delete button. `new_files` is often
// empty (a triage that created nothing), in which case the whole section is omitted.
function NewFilesSection({ reportId, files }: { reportId: string; files: string[] }) {
	if (files.length === 0) return null;
	return (
		<>
			<div class="section-h">Files created during triage</div>
			<ul class="triage-files">
				{files.map((path) => (
					<TriageFileRow key={path} reportId={reportId} path={path} />
				))}
			</ul>
		</>
	);
}

function TriageFileRow({ reportId, path }: { reportId: string; path: string }) {
	const dispatch = useDispatch();
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onDelete = () => {
		setDeleting(true);
		setError(null);
		// On success the file drops out of state and this row unmounts, so there's nothing to
		// reset; only re-enable the button if the delete failed.
		deleteTriageFile(dispatch, reportId, path).catch((e: AppError) => {
			setError(e.message || "Failed to delete file");
			setDeleting(false);
		});
	};

	return (
		<li class="triage-file">
			<span class="triage-file-path" title={path}>
				{path}
			</span>
			<button type="button" class="triage-file-delete" onClick={onDelete} disabled={deleting}>
				{deleting ? "Deleting…" : "Delete"}
			</button>
			{error ? <span class="triage-file-error">{error}</span> : null}
		</li>
	);
}

export function TriageEventLog({ events, live }: { events: TriageEvent[]; live: boolean }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!live) return;
		const el = ref.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [events.length, live]);
	const items = toLogItems(events);
	return (
		<div class="triage-log" ref={ref}>
			{items.map((item, i) => (
				<TriageLogRow key={i} item={item} />
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
	if (typeof input.description === "string" && input.description.trim()) {
		return input.description.trim();
	}
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

// A tool call that was blocked by the permission system didn't fail — claude simply wasn't
// allowed to run it — so it's labelled and coloured apart from a genuine failure.
type OutcomeStatus = "ok" | "error" | "denied";
type ToolOutcome = { text: string; status: OutcomeStatus };

// The log is rendered from a flattened item list rather than straight from events: runs of
// thinking events collapse into one row, and a tool result is folded into the row of the tool
// call it belongs to.
type LogItem =
	| { kind: "system"; text: string }
	| { kind: "thinking" }
	| { kind: "assistant"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool"; name: string; summary: string; outcome: ToolOutcome | null; elapsed: number }
	| { kind: "task"; description: string; outcome: ToolOutcome | null }
	| { kind: "outcome"; outcome: ToolOutcome }
	| { kind: "final"; text: string };

type ToolItem = LogItem & { kind: "tool" };
type TaskItem = LogItem & { kind: "task" };

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

// The line to show for a system event, or null for the ones carrying no information a
// neighbouring row doesn't already give (bookkeeping, empty status pings).
function systemLine(event: TriageEvent, subtype: string): string | null {
	switch (subtype) {
		case "init":
			return `Started ${str(event.model)}`.trim();
		case "status":
			return str(event.status) || null;
		// Emitted alongside every task lifecycle event with the full task list — the task rows
		// already say the same thing in a readable way.
		case "background_tasks_changed":
			return null;
		default: {
			// Unknown subtypes — pull whichever field has actual content.
			const detail =
				str(event.description) || str(event.message) || str(event.content) || str(event.model);
			return [subtype, detail].filter(Boolean).join(" ") || null;
		}
	}
}

function toLogItems(events: TriageEvent[]): LogItem[] {
	const items: LogItem[] = [];
	// tool_use_id → its tool row, so parallel tool calls in one assistant message each pick up
	// the right result out of the following user message.
	const toolsById = new Map<string, ToolItem>();
	// Tools the permission system blocked. The `permission_denied` event arrives before the
	// tool_result, so the denial is recorded here and applied when the result lands.
	const denied = new Set<string>();
	// task_id → its background-task row, so the later lifecycle events fold into the row that
	// started the task rather than repeating its description further down the log.
	const tasksById = new Map<string, TaskItem>();
	// The run's result repeats the final assistant message verbatim, and that's rendered as
	// formatted markdown in the analysis section directly below the log — so the log skips its
	// own copy, which is otherwise a screenful of raw verdict JSON. Failed runs save no record,
	// leaving nothing else to show it, so those are left in place.
	const finalTexts = new Set(
		events
			.filter((e) => e.type === "result" && e.is_error !== true)
			.map((e) => str(e.result).trim())
			.filter(Boolean),
	);

	for (const event of events) {
		const t = event.type;
		if (t === "system") {
			const subtype = str(event.subtype);
			if (subtype === "thinking_tokens") {
				if (items[items.length - 1]?.kind !== "thinking") items.push({ kind: "thinking" });
				continue;
			}
			if (subtype === "permission_denied") {
				const id = str(event.tool_use_id);
				const tool = toolsById.get(id);
				if (id) denied.add(id);
				if (tool?.outcome) tool.outcome.status = "denied";
				// Without a tool to attach to there's nothing else showing the denial, so keep it.
				if (!tool) items.push({ kind: "system", text: str(event.message) || "Permission denied" });
				continue;
			}
			if (subtype === "task_started") {
				const item: TaskItem = {
					kind: "task",
					description: str(event.description) || str(event.task_id) || "(unnamed)",
					outcome: null,
				};
				items.push(item);
				if (str(event.task_id)) tasksById.set(event.task_id, item);
				continue;
			}
			// The end of a task arrives as both an update and a notification, in either order, so
			// each overwrites the last — they describe the same finish.
			if (subtype === "task_updated" || subtype === "task_notification") {
				const status = str(event.status) || str(event.patch?.status);
				if (!status) continue;
				const outcome: ToolOutcome = {
					text: status,
					status: /fail|error/i.test(status) ? "error" : "ok",
				};
				const task = tasksById.get(str(event.task_id));
				if (task) task.outcome = outcome;
				else items.push({ kind: "system", text: `Background task ${status}` });
				continue;
			}
			const line = systemLine(event, subtype || "system");
			if (line) items.push({ kind: "system", text: line });
			continue;
		}
		if (t === "assistant") {
			const content = event.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text") {
					const text = String(block.text ?? "").trim();
					if (text && !finalTexts.has(text)) items.push({ kind: "assistant", text });
				} else if (block.type === "thinking") {
					const text = String(block.thinking ?? "").trim();
					if (text) items.push({ kind: "reasoning", text });
				} else if (block.type === "tool_use") {
					const item: ToolItem = {
						kind: "tool",
						name: prettyToolName(String(block.name ?? "(unknown)")),
						summary: summarizeToolInput(String(block.name ?? ""), block.input),
						outcome: null,
						elapsed: 0,
					};
					items.push(item);
					if (str(block.id)) toolsById.set(block.id, item);
				}
			}
			continue;
		}
		if (t === "user") {
			const content = event.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!block || block.type !== "tool_result") continue;
				const id = str(block.tool_use_id);
				const errored = block.is_error === true || isToolResultError(block.content);
				const outcome: ToolOutcome = {
					text: summarizeToolResult(block.content) || "(empty)",
					status: denied.has(id) ? "denied" : errored ? "error" : "ok",
				};
				const tool = toolsById.get(id);
				if (tool) tool.outcome = outcome;
				else items.push({ kind: "outcome", outcome });
			}
			continue;
		}
		if (t === "result") {
			const subtype = str(event.subtype) || "done";
			const duration =
				typeof event.duration_ms === "number" ? `${Math.round(event.duration_ms / 1000)}s` : "";
			const text = [subtype, duration].filter(Boolean).join(" ");
			items.push(
				event.is_error === true || subtype.startsWith("error")
					? { kind: "outcome", outcome: { text, status: "error" } }
					: { kind: "final", text },
			);
			continue;
		}
		if (t === "raw") {
			items.push({ kind: "system", text: String(event.line ?? "") });
			continue;
		}
		// Progress pings for a tool that's still running: a heartbeat, an elapsed-time tick, or a
		// subagent retry. Only the retry is worth a row of its own — the rest just time-stamp the
		// tool call they belong to, which is already on screen.
		if (t === "tool_progress") {
			const retry = event.subagent_retry;
			if (retry && typeof retry === "object") {
				const attempt = [retry.attempt, retry.max_retries].filter(Boolean).join("/");
				const agent = str(event.subagent_type) || "Subagent";
				items.push({ kind: "system", text: `${agent} retrying${attempt ? ` (${attempt})` : ""}` });
				continue;
			}
			// Heartbeats carry a synthetic `<id>-heartbeat-N` tool_use_id and put the real one in
			// parent_tool_use_id, so fall back to the parent when the id doesn't resolve.
			const tool =
				toolsById.get(str(event.tool_use_id)) ?? toolsById.get(str(event.parent_tool_use_id));
			const elapsed = event.elapsed_time_seconds;
			if (tool && typeof elapsed === "number" && elapsed > tool.elapsed) tool.elapsed = elapsed;
			continue;
		}
		if (t === "rate_limit_event") {
			// Sent on every turn; only worth a row when it says something other than "allowed".
			const status = str(event.rate_limit_info?.status);
			if (status && status !== "allowed")
				items.push({ kind: "system", text: `Rate limit: ${status}` });
			continue;
		}
		items.push({ kind: "system", text: t.replace(/_/g, " ") });
	}
	return items;
}

function formatElapsed(seconds: number): string {
	const whole = Math.round(seconds);
	if (whole < 60) return `${whole}s`;
	return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

const OUTCOME_PREFIX: Record<OutcomeStatus, string> = {
	ok: "",
	error: "Error: ",
	denied: "Blocked: ",
};

function Outcome({ outcome, attached }: { outcome: ToolOutcome; attached: boolean }) {
	const classes = ["triage-event-outcome", `triage-event-outcome-${outcome.status}`];
	if (attached) classes.push("triage-event-outcome-attached");
	return <div class={classes.join(" ")}>{`${OUTCOME_PREFIX[outcome.status]}${outcome.text}`}</div>;
}

function TriageLogRow({ item }: { item: LogItem }) {
	switch (item.kind) {
		case "thinking":
			return <div class="triage-event triage-event-thinking">Thinking…</div>;
		case "assistant":
			return <div class="triage-event triage-event-assistant">{item.text}</div>;
		case "reasoning":
			return <div class="triage-event triage-event-reasoning">{item.text}</div>;
		case "tool":
			return (
				<div class="triage-event triage-event-tool">
					<div class="triage-event-tool-call">
						<span class="triage-event-tool-name">{item.name}</span>
						{item.summary ? <span class="triage-event-tool-args">{item.summary}</span> : null}
						{item.elapsed >= 1 ? (
							<span class="triage-event-tool-time">{formatElapsed(item.elapsed)}</span>
						) : null}
					</div>
					{item.outcome ? <Outcome outcome={item.outcome} attached /> : null}
				</div>
			);
		case "task":
			return (
				<div class="triage-event triage-event-task">
					<div class="triage-event-tool-call">
						<span class="triage-event-task-label">Background task</span>
						<span class="triage-event-tool-args">{item.description}</span>
					</div>
					{item.outcome ? <Outcome outcome={item.outcome} attached /> : null}
				</div>
			);
		case "outcome":
			return (
				<div class="triage-event">
					<Outcome outcome={item.outcome} attached={false} />
				</div>
			);
		case "final":
			return <div class="triage-event triage-event-final">{item.text}</div>;
		default:
			return <div class="triage-event triage-event-system">{item.text}</div>;
	}
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
