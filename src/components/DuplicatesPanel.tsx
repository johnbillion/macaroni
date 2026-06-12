import { useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { runDuplicateCheck, stopDuplicateCheck } from "../state/effects";
import type { AppError, DuplicateInput } from "../state/store";
import { Markdown } from "./Markdown";
import { ReportLink } from "./ReportLink";
import { TriageEventLog } from "./TriagePanel";

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

// Stable key for the streamed event channel and the stop signal — derived from the set of
// reports under comparison, so it changes whenever the selection does.
function requestIdFor(reports: DuplicateInput[]): string {
	return `dup:${reports.map((r) => r.id).join("-")}`;
}

export function DuplicatesPanel() {
	const state = useAppState();
	const dispatch = useDispatch();
	const check = state.duplicateCheck;

	// Build the comparison inputs from the loaded report summaries (which already carry the
	// description), sorted ascending by id so the lowest-id canonical report comes first.
	const items = state.reports.status === "ready" ? state.reports.data.items : [];
	const reports: DuplicateInput[] = items
		.filter((r) => state.selectedReportIds.has(r.id))
		.slice()
		.sort((a, b) => Number(a.id) - Number(b.id))
		.map((r) => ({ id: r.id, title: r.title, body: r.vulnerability_information }));

	const requestId = requestIdFor(reports);

	const displayReports = reports.slice().reverse();

	const onRun = () => {
		if (reports.length < 2) return;
		void runDuplicateCheck(dispatch, requestId, reports);
	};

	return (
		<div class="triage dup-panel">
			<div class="triage-head">
				<div class="triage-title">Duplicate check</div>
				<div class="triage-sub">
					Ask Claude whether these reports duplicate one another. The oldest report is treated as
					canonical.
				</div>
				<ul class="dup-report-list">
					{displayReports.map((r) => (
						<li key={r.id} class="dup-report">
							<span class="dup-report-id">
								<ReportLink id={r.id} />
							</span>
							<span class="dup-report-title">{r.title}</span>
						</li>
					))}
				</ul>
				{check.status === "running" ? (
					<DuplicatesRunning requestId={requestId} />
				) : (
					<button type="button" class="triage-run" onClick={onRun} disabled={reports.length < 2}>
						{check.status === "ready" || check.status === "error"
							? "Re-check for duplicates"
							: "Check for duplicates"}
					</button>
				)}
			</div>

			{check.status === "running" ? <TriageEventLog events={check.events} live /> : null}

			{check.status === "ready" ? (
				<>
					{check.events.length > 0 ? (
						<details class="triage-events">
							<summary>Run log ({check.events.length} events)</summary>
							<TriageEventLog events={check.events} live={false} />
						</details>
					) : null}
					<div class="section-h">Verdict</div>
					<Markdown source={check.result.summary} class="body-text" />
				</>
			) : null}

			{check.status === "error" ? (
				<>
					<div class="triage-error">Failed: {formatError(check.error)}</div>
					{check.events.length > 0 ? <TriageEventLog events={check.events} live={false} /> : null}
				</>
			) : null}
		</div>
	);
}

function DuplicatesRunning({ requestId }: { requestId: string }) {
	const [stopping, setStopping] = useState(false);
	const onStop = () => {
		setStopping(true);
		void stopDuplicateCheck(requestId);
	};
	return (
		<button type="button" class="triage-run triage-stop" onClick={onStop} disabled={stopping}>
			{stopping ? "Stopping…" : "Stop"}
		</button>
	);
}
