import { useEffect, useRef } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import {
	buildReportsQuery,
	loadMoreReports,
	loadReportDetail,
	loadReports,
	markReportRead,
} from "../state/effects";
import type { AppError } from "../state/store";
import { pillFor } from "../utils/pill";
import { formatRelativeTime } from "../utils/time";
import { AssetIdentifier } from "./AssetIdentifier";

function formatReportError(error: AppError): string {
	switch (error.kind) {
		case "network":
			return error.message;
		case "unauthorized":
			return "Your credentials were rejected. Open Settings to re-enter your API token.";
		case "forbidden":
			return "Your API token doesn't have access to these reports.";
		case "rate_limited":
			return "Rate limited by HackerOne. Wait a moment and try again.";
		default:
			return error.message;
	}
}

export function InboxTable() {
	const state = useAppState();
	const dispatch = useDispatch();
	const inboxRef = useRef<HTMLElement>(null);

	useEffect(() => {
		inboxRef.current?.scrollTo({ top: 0 });
	}, [state.reportsReplaceCount]);

	const onSelect = (id: string) => {
		dispatch({ type: "REPORT_SELECTED", reportId: id });
		const existing = state.detail[id];
		if (!existing || existing.status === "error") {
			loadReportDetail(dispatch, id);
		} else if (existing.status === "ready" && !state.readReports[id]) {
			markReportRead(dispatch, id);
		}
	};

	const onRetryReports = () => {
		const query = buildReportsQuery(state);
		if (query) loadReports(dispatch, query);
	};

	const body = (() => {
		if (state.reports.status === "idle") {
			return <div class="placeholder">Select a program to load its reports.</div>;
		}
		if (state.reports.status === "loading") {
			return <div class="placeholder">Loading reports…</div>;
		}
		if (state.reports.status === "error") {
			return (
				<div class="placeholder error">
					<p>{formatReportError(state.reports.error)}</p>
					<button type="button" class="retry-btn" onClick={onRetryReports}>
						Try again
					</button>
				</div>
			);
		}
		if (state.reports.data.items.length === 0) {
			return <div class="placeholder">No reports.</div>;
		}

		const items = state.reports.data.items;
		const hasMore = !!state.reports.data.nextCursor;

		return (
			<table class="inbox-table">
				<thead>
					<tr>
						<th class="th-check">
							<input type="checkbox" class="cb" aria-label="Select all" />
						</th>
						<th>ID</th>
						<th>OPENED</th>
						<th>STATUS</th>
						<th class="th-asset">ASSET</th>
						<th class="th-title">TITLE</th>
					</tr>
				</thead>
				<tbody>
					{items.map((r) => {
						const pill = pillFor(r.state);
						const isSelected = state.selectedReportId === r.id;
						const isUnread = !state.readReports[r.id];
						const classes = ["row"];
						if (isSelected) classes.push("selected");
						if (isUnread) classes.push("unread");
						return (
							<tr key={r.id} class={classes.join(" ")} onClick={() => onSelect(r.id)}>
								<td class="check">
									<input
										type="checkbox"
										class="cb"
										aria-label="Select report"
										onClick={(e) => e.stopPropagation()}
									/>
								</td>
								<td class="id">#{r.id}</td>
								<td class="date">{formatRelativeTime(r.created_at)}</td>
								<td>
									<span class={`pill ${pill.className}`}>{pill.label}</span>
								</td>
								<td class="asset">
									{r.asset?.asset_identifier ? (
										<AssetIdentifier identifier={r.asset.asset_identifier} />
									) : (
										""
									)}
								</td>
								<td class="title">{r.title}</td>
							</tr>
						);
					})}
				</tbody>
				<tfoot>
					<tr class="footer-row">
						<td colspan={6}>
							<div class="inbox-footer">
								<span class="footer-total">
									{items.length} {items.length === 1 ? "report" : "reports"}
								</span>
								{hasMore ? (
									<>
										{state.reportsLoadMoreError && !state.reportsRefreshing ? (
											<span class="footer-error">
												{formatReportError(state.reportsLoadMoreError)}
											</span>
										) : null}
										<button
											type="button"
											class="load-more-btn"
											onClick={() => loadMoreReports(dispatch, state)}
											disabled={state.reportsRefreshing}
										>
											{state.reportsRefreshing
												? "Loading…"
												: state.reportsLoadMoreError
													? "Try again"
													: "Load more"}
										</button>
									</>
								) : (
									<span class="footer-end">- END -</span>
								)}
							</div>
						</td>
					</tr>
				</tfoot>
			</table>
		);
	})();

	return (
		<main class="inbox" ref={inboxRef}>
			<div
				class={`loading-bar${state.reportsRefreshing ? " active" : ""}`}
				role="progressbar"
				aria-label="Refreshing reports"
				aria-hidden={!state.reportsRefreshing}
			/>
			{body}
		</main>
	);
}
