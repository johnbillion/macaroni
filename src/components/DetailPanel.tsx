import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import type { Activity, DetailToast } from "../state/store";
import { pillFor } from "../utils/pill";
import { formatClock } from "../utils/time";
import { TriageDisclosure } from "./TriagePanel";
import { AssetIdentifier } from "./AssetIdentifier";
import { Avatar } from "./Avatar";
import { describeEvent, renderActivity } from "./activity/renderActivity";
import { BulkEditPanel } from "./BulkEditPanel";
import { DuplicatesPanel } from "./DuplicatesPanel";
import { Markdown } from "./Markdown";
import { RelativeTime } from "./RelativeTime";
import { ReportLink } from "./ReportLink";
import { SeverityMeter } from "./SeverityMeter";

function isHackbotPreSubmissionTrigger(a: Activity | undefined): boolean {
	if (!a) return false;
	if (a.type !== "comment") return false;
	if (a.actor?.username?.toLowerCase() !== "hackbot") return false;
	return /pre-submission[- ]trigger/i.test(a.message);
}

function CopyButton({
	text,
	label,
	copiedLabel = "Copied!",
	class: className,
}: {
	text: string;
	label: string;
	copiedLabel?: string;
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
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
			}}
		>
			{copied ? copiedLabel : label}
		</button>
	);
}

function SaveFileButton({
	contents,
	filename,
	label,
	class: className,
}: {
	contents: string;
	filename: string;
	label: string;
	class?: string;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<button
			type="button"
			class={className}
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					await api.saveTextFile(contents, filename);
				} finally {
					setBusy(false);
				}
			}}
		>
			{label}
		</button>
	);
}

export function DetailPanel() {
	const state = useAppState();
	const dispatch = useDispatch();
	const bulkActive = state.selectedReportIds.size > 0;
	// The duplicate check only makes sense for two or more reports, so its tab appears only then.
	const canCheckDuplicates = state.selectedReportIds.size > 1;
	const setActiveTab = (tab: "report" | "bulk" | "duplicates") =>
		dispatch({ type: "DETAIL_TAB_SET", tab });
	// Fall back off the duplicates tab if the selection has dropped below two — its tab is gone.
	const activeTab =
		state.detailActiveTab === "duplicates" && !canCheckDuplicates ? "bulk" : state.detailActiveTab;
	const prevBulkActive = useRef(false);
	useEffect(() => {
		if (bulkActive && !prevBulkActive.current) setActiveTab("bulk");
		if (!bulkActive && prevBulkActive.current) setActiveTab("report");
		prevBulkActive.current = bulkActive;
		// setActiveTab dispatches via context and never changes identity
		// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	}, [bulkActive]);

	return (
		<aside class="detail">
			<div class="detail-scroll">
				{bulkActive ? (
					<div class="detail-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "report"}
							class={`detail-tab${activeTab === "report" ? " active" : ""}`}
							onClick={() => setActiveTab("report")}
						>
							Report
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "bulk"}
							class={`detail-tab${activeTab === "bulk" ? " active" : ""}`}
							onClick={() => setActiveTab("bulk")}
						>
							Bulk edit ({state.selectedReportIds.size})
						</button>
						{canCheckDuplicates ? (
							<button
								type="button"
								role="tab"
								aria-selected={activeTab === "duplicates"}
								class={`detail-tab${activeTab === "duplicates" ? " active" : ""}`}
								onClick={() => setActiveTab("duplicates")}
							>
								Duplicates
							</button>
						) : null}
					</div>
				) : null}
				{bulkActive && activeTab === "bulk" ? (
					<BulkEditPanel />
				) : bulkActive && activeTab === "duplicates" ? (
					<DuplicatesPanel />
				) : (
					<ReportTab />
				)}
			</div>
			{!bulkActive || activeTab === "report" ? <ToastStack toasts={state.detailToasts} /> : null}
		</aside>
	);
}

const TOAST_AUTO_DISMISS_MS = 10000;

function scrollToActivity(activityId: string) {
	const el = document.querySelector(`[data-activity-id="${CSS.escape(activityId)}"]`);
	if (el instanceof HTMLElement) {
		el.scrollIntoView({ behavior: "smooth", block: "center" });
	}
}

// Render the same rich verb-phrase the activity log uses (via describeEvent), prefixed
// with the actor, for toasts that describe a single event activity. Returns null for
// comments, state changes, and event kinds describeEvent doesn't phrase — those fall back
// to the toast's plain `message`, which already reads well for them.
function toastDescription(
	activity: DetailToast["activity"],
	programCurrency: string | null,
): JSX.Element | null {
	if (!activity || activity.type !== "event") return null;
	const phrase = describeEvent(activity, null, programCurrency);
	if (!phrase) return null;
	const actor = activity.actor?.username ?? "system";
	return (
		<>
			<b>{actor}</b> {phrase}
		</>
	);
}

function ToastStack({ toasts }: { toasts: DetailToast[] }) {
	const dispatch = useDispatch();
	const state = useAppState();
	const programCurrency =
		state.reports.status === "ready"
			? (state.reports.data.items.find((it) => it.bounty?.currency)?.bounty?.currency ?? null)
			: null;
	useEffect(() => {
		if (toasts.length === 0) return;
		const timers = toasts.map((t) =>
			window.setTimeout(
				() => dispatch({ type: "DETAIL_TOAST_DISMISSED", toastId: t.id }),
				TOAST_AUTO_DISMISS_MS,
			),
		);
		return () => {
			for (const id of timers) window.clearTimeout(id);
		};
	}, [toasts, dispatch]);
	if (toasts.length === 0) return null;
	return (
		<div class="detail-toasts" role="status" aria-live="polite">
			{toasts.map((t) => {
				const clickable = !!t.activityId;
				const onClick = clickable
					? () => {
							if (t.activityId) scrollToActivity(t.activityId);
							dispatch({ type: "DETAIL_TOAST_DISMISSED", toastId: t.id });
						}
					: undefined;
				return (
					<div
						key={t.id}
						class={`detail-toast${clickable ? " clickable" : ""}`}
						role={clickable ? "button" : undefined}
						tabIndex={clickable ? 0 : undefined}
						onClick={onClick}
						onKeyDown={
							clickable
								? (e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											onClick?.();
										}
									}
								: undefined
						}
					>
						<span class="detail-toast-msg">
							{toastDescription(t.activity, programCurrency) ?? t.message}
						</span>
						<button
							type="button"
							class="detail-toast-close"
							aria-label="Dismiss"
							onClick={(e) => {
								e.stopPropagation();
								dispatch({ type: "DETAIL_TOAST_DISMISSED", toastId: t.id });
							}}
						>
							×
						</button>
					</div>
				);
			})}
		</div>
	);
}

function ReportTab() {
	const state = useAppState();
	const id = state.selectedReportId;

	if (!id) {
		return <div class="detail-empty">Select a report</div>;
	}

	const detail = state.detail[id];
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

	const r = detail.data;
	const pending = !!state.detailPending[id];
	const pill = pillFor(r.state);
	const submittedClock = formatClock(r.created_at);
	const reporterUsername = r.reporter.username;
	const reporterName = r.reporter.name;
	const activities = isHackbotPreSubmissionTrigger(r.activities[0])
		? r.activities.slice(1)
		: r.activities;

	// Hide the program's built-in `default` inbox — it's named after the program and
	// adds no information beyond the currently selected program.
	const inboxes = r.inboxes.filter((inbox) => inbox.kind !== "default");

	// If this report was closed as a duplicate, surface the canonical report it points
	// to. The link only exists on the `bug-duplicate` activity, so derive it from the
	// timeline — taking the most recent one in case the report was reopened and
	// re-duplicated against a different original.
	const duplicateEvents = r.activities.filter(
		(a): a is Extract<Activity, { type: "event" }> =>
			a.type === "event" && a.kind === "bug-duplicate" && !!a.original_report_id,
	);
	const duplicateOf = duplicateEvents[duplicateEvents.length - 1]?.original_report_id ?? null;

	// The H1 API doesn't carry the inbox name on `report-organization-inboxes-updated`
	// activities, so we can only name it on the most recent one — whose result is the
	// report's current custom inbox(es). Older inbox-update events stay generic.
	const inboxNames = inboxes.map((inbox) => inbox.name);
	const inboxUpdateEvents = r.activities.filter(
		(a) => a.type === "event" && a.kind === "report-organization-inboxes-updated",
	);
	const latestInboxUpdateId = inboxUpdateEvents[inboxUpdateEvents.length - 1]?.id ?? null;

	const handle = state.filters.programHandle ?? null;
	// Suggested-bounty activities carry no currency; a program pays in a single
	// currency, so borrow it from the first awarded bounty in the loaded inbox list.
	const programCurrency =
		state.reports.status === "ready"
			? (state.reports.data.items.find((it) => it.bounty?.currency)?.bounty?.currency ?? null)
			: null;
	const members = handle ? state.teamMembersByProgram[handle] : undefined;
	const teamMemberIds: Set<string> =
		members?.status === "ready" ? new Set(members.data.map((m) => m.id)) : new Set();

	return (
		<>
			<div class="detail-head">
				<div class="dh-meta">
					<span>#{r.id}</span>
					<span>
						Submitted {submittedClock}
						{" · "}
						<RelativeTime iso={r.created_at} />
					</span>
					{duplicateOf ? (
						<span class={`pill ${pill.className}`}>
							{pill.label} of <ReportLink id={duplicateOf} />
						</span>
					) : (
						<span class={`pill ${pill.className}`}>{pill.label}</span>
					)}
					<CopyButton text={r.id} label="Copy ID" class="dh-action dh-action-first" />
					<button
						type="button"
						class="dh-action"
						onClick={() => openUrl(`https://hackerone.com/reports/${r.id}`)}
					>
						Open ↗
					</button>
				</div>
				<h1 class="dh-title">{r.title}</h1>
				<dl class="kv">
					<dt>Asset</dt>
					<dd>
						{r.asset?.asset_identifier ? (
							<AssetIdentifier identifier={r.asset.asset_identifier} />
						) : (
							<span class="kv-missing">None</span>
						)}
					</dd>
					<dt>Inbox</dt>
					<dd>
						{inboxes.length > 0 ? (
							<span class="kv-inboxes">
								{inboxes.map((inbox) => (
									<span
										key={inbox.id}
										class={`kv-inbox${inbox.kind === "custom" ? " kv-inbox-custom" : ""}`}
									>
										{inbox.name}
									</span>
								))}
							</span>
						) : (
							<>Default</>
						)}
					</dd>
					<dt>Reporter</dt>
					<dd class="kv-person">
						<Avatar user={r.reporter} />
						<span>
							{reporterUsername}
							{reporterName ? ` (${reporterName})` : ""}
						</span>
					</dd>
					<dt>Weakness</dt>
					<dd>
						{r.weakness?.name ?? "Unknown"}
						{r.weakness?.external_id ? ` (${r.weakness.external_id.toUpperCase()})` : ""}
					</dd>
					<dt>Severity</dt>
					<dd>
						<SeverityMeter rating={r.severity_rating} showLabel />
					</dd>
					{(r.issue_tracker_reference_id || r.issue_tracker_reference_url) && (
						<>
							<dt>Reference</dt>
							<dd>
								{r.issue_tracker_reference_url ? (
									<a
										href={r.issue_tracker_reference_url}
										target="_blank"
										rel="noopener noreferrer"
										onClick={(e) => {
											e.preventDefault();
											openUrl(r.issue_tracker_reference_url as string);
										}}
									>
										{r.issue_tracker_reference_id ?? r.issue_tracker_reference_url}
									</a>
								) : (
									r.issue_tracker_reference_id
								)}
							</dd>
						</>
					)}
				</dl>
			</div>

			<TriageDisclosure />

			<div class="section">
				<div class="section-h">
					Description
					{r.vulnerability_information && (
						<>
							<CopyButton
								text={r.vulnerability_information}
								label="Copy markdown"
								class="section-action"
							/>
							<SaveFileButton
								contents={r.vulnerability_information}
								filename={`${r.id}.md`}
								label="Save as file"
								class="section-action"
							/>
						</>
					)}
				</div>
				{r.vulnerability_information ? (
					<Markdown
						source={r.vulnerability_information}
						attachments={r.attachments}
						class="body-text"
					/>
				) : (
					<div class="body-text">(no description)</div>
				)}
			</div>

			<div class="section">
				<div class="section-h">Discussion</div>
				{activities.length === 0 ? (
					<div class="placeholder">{pending ? "Loading discussion…" : "No activity yet."}</div>
				) : (
					<div class="thread">
						{activities.map((a) =>
							renderActivity(
								a,
								r.reporter.id,
								teamMemberIds,
								handle,
								a.id === latestInboxUpdateId ? inboxNames : null,
								programCurrency,
							),
						)}
						<div class="thread-end">— END —</div>
					</div>
				)}
			</div>
		</>
	);
}
