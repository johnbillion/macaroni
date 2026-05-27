import { useEffect } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { loadReportDetail, loadReports, markReportRead } from "../state/effects";
import { pillFor } from "../utils/pill";
import { formatRelativeTime } from "../utils/time";

export function InboxTable() {
	const state = useAppState();
	const dispatch = useDispatch();
	const program = state.filters.programHandle;

	useEffect(() => {
		if (program && state.reports.status === "idle") {
			loadReports(dispatch, program, []);
		}
	}, [program, state.reports.status, dispatch]);

	const onSelect = (id: string) => {
		dispatch({ type: "REPORT_SELECTED", reportId: id });
		const existing = state.detail[id];
		if (!existing || existing.status === "error") {
			loadReportDetail(dispatch, id);
		} else if (existing.status === "ready" && !state.readReports[id]) {
			markReportRead(dispatch, id);
		}
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
					{state.reports.error.kind}: {state.reports.error.message}
				</div>
			);
		}
		if (state.reports.data.items.length === 0) {
			return <div class="placeholder">No reports.</div>;
		}

		const items = state.reports.data.items.slice(0, 100);

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
								<td class="asset">{r.asset?.asset_identifier ?? ""}</td>
								<td class="title">{r.title}</td>
							</tr>
						);
					})}
				</tbody>
				<tfoot>
					<tr class="end-row">
						<td colspan={6}>- END -</td>
					</tr>
				</tfoot>
			</table>
		);
	})();

	return <main class="inbox">{body}</main>;
}
