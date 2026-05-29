import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { CLOSED_STATE_CHANGE_TARGETS, OPEN_STATE_CHANGE_TARGETS } from "../state/filters";
import type { Activity, DetailToast } from "../state/store";
import { pillFor } from "../utils/pill";
import { formatClock } from "../utils/time";
import { TriageDisclosure } from "./TriagePanel";
import { AssetIdentifier } from "./AssetIdentifier";
import { Avatar } from "./Avatar";
import { renderActivity } from "./activity/renderActivity";
import { BulkEditPanel } from "./BulkEditPanel";
import { Markdown } from "./Markdown";
import { RelativeTime } from "./RelativeTime";
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
	copiedLabel = "COPIED!",
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

export function DetailPanel() {
	const state = useAppState();
	const dispatch = useDispatch();
	const bulkActive = state.selectedReportIds.size > 0;
	const activeTab = state.detailActiveTab;
	const setActiveTab = (tab: "report" | "bulk") => dispatch({ type: "DETAIL_TAB_SET", tab });
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
					</div>
				) : null}
				{bulkActive && activeTab === "bulk" ? <BulkEditPanel /> : <ReportTab />}
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

function ToastStack({ toasts }: { toasts: DetailToast[] }) {
	const dispatch = useDispatch();
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
						<span class="detail-toast-msg">{t.message}</span>
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
		return <div class="detail-empty">SELECT A REPORT</div>;
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
	const pill = pillFor(r.state);
	const submittedClock = r.submitted_at ? formatClock(r.submitted_at) : "";
	const reporterUsername = r.reporter.username;
	const reporterName = r.reporter.name;
	const activities = isHackbotPreSubmissionTrigger(r.activities[0])
		? r.activities.slice(1)
		: r.activities;

	const handle = state.filters.programHandle ?? null;
	const members = handle ? state.teamMembersByProgram[handle] : undefined;
	const teamMemberIds: Set<string> =
		members?.status === "ready" ? new Set(members.data.map((m) => m.id)) : new Set();

	return (
		<aside class="detail">
			<div class="detail-head">
				<div class="dh-meta">
					<span>#{r.id}</span>
					<span>
						SUBMITTED {submittedClock}
						{r.submitted_at ? (
							<>
								{" · "}
								<RelativeTime iso={r.submitted_at} />
							</>
						) : null}
					</span>
					<span class={`pill ${pill.className}`}>{pill.label}</span>
					<CopyButton text={r.id} label="COPY ID" class="dh-action dh-action-first" />
					<button
						type="button"
						class="dh-action"
						onClick={() => openUrl(`https://hackerone.com/reports/${r.id}`)}
					>
						OPEN ↗
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
					DESCRIPTION
					{r.vulnerability_information && (
						<CopyButton
							text={r.vulnerability_information}
							label="COPY MARKDOWN"
							class="section-action"
						/>
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
				<div class="section-h">DISCUSSION</div>
				{activities.length === 0 ? (
					<div class="placeholder">No activity yet.</div>
				) : (
					<div class="thread">
						{activities.map((a) => renderActivity(a, r.reporter.id, teamMemberIds, handle))}
						<div class="thread-end">— END —</div>
					</div>
				)}
			</div>
		</aside>
	);
}
