import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { buildReportsQuery, loadMoreReports, loadReports } from "../state/effects";
import type { AppError, AssigneeRef, UserRef } from "../state/store";
import { pillFor } from "../utils/pill";
import { formatRelativeTime } from "../utils/time";
import { AssetIdentifier } from "./AssetIdentifier";
import { Avatar } from "./Avatar";
import { SeverityMeter } from "./SeverityMeter";

const COLUMN_DEFS = [
	{ key: "id", label: "ID", defaultVisible: true },
	{ key: "opened", label: "Opened", defaultVisible: true },
	{ key: "updated", label: "Updated", defaultVisible: false },
	{ key: "status", label: "Status", defaultVisible: true },
	{ key: "severity", label: "Severity", defaultVisible: false },
	{ key: "asset", label: "Asset", defaultVisible: true },
	{ key: "title", label: "Title", defaultVisible: true },
	{ key: "reporter", label: "Reporter", defaultVisible: false },
	{ key: "assignee", label: "Assignee", defaultVisible: false },
	{ key: "reference", label: "Reference", defaultVisible: false },
] as const;

type ColumnKey = (typeof COLUMN_DEFS)[number]["key"];

const DEFAULT_VISIBILITY = Object.fromEntries(
	COLUMN_DEFS.map((c) => [c.key, c.defaultVisible]),
) as Record<ColumnKey, boolean>;

const COLUMN_STORAGE_KEY = "macaroni.columns";

function loadColumnVisibility(): Record<ColumnKey, boolean> {
	try {
		const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_VISIBILITY };
		const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, unknown>>;
		const out = { ...DEFAULT_VISIBILITY };
		for (const { key } of COLUMN_DEFS) {
			if (typeof parsed[key] === "boolean") out[key] = parsed[key] as boolean;
		}
		return out;
	} catch {
		return { ...DEFAULT_VISIBILITY };
	}
}

function useColumnVisibility() {
	const [visibility, setVisibility] =
		useState<Record<ColumnKey, boolean>>(loadColumnVisibility);
	useEffect(() => {
		localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibility));
	}, [visibility]);
	const toggle = (key: ColumnKey) =>
		setVisibility((v) => ({ ...v, [key]: !v[key] }));
	return { visibility, toggle };
}

function ColumnsMenu({
	visibility,
	onToggle,
}: {
	visibility: Record<ColumnKey, boolean>;
	onToggle: (key: ColumnKey) => void;
}) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const openMenu = async () => {
		const items = await Promise.all(
			COLUMN_DEFS.map((col) =>
				CheckMenuItem.new({
					id: col.key,
					text: col.label,
					checked: visibility[col.key],
					action: () => onToggle(col.key),
				}),
			),
		);
		const menu = await Menu.new({ items });
		const rect = btnRef.current?.getBoundingClientRect();
		if (rect) {
			await menu.popup(new LogicalPosition(rect.left, rect.bottom));
		} else {
			await menu.popup();
		}
	};
	return (
		<div class="columns-menu">
			<button
				ref={btnRef}
				type="button"
				class="columns-menu-btn"
				aria-haspopup="true"
				aria-label="Toggle columns"
				onClick={openMenu}
			>
				⚙
			</button>
		</div>
	);
}

function renderPerson(person: UserRef | AssigneeRef | null) {
	if (!person) return null;
	const label = person.username ?? person.name ?? "";
	return (
		<span class="person-cell">
			<Avatar user={person} />
			<span class="person-name">{label}</span>
		</span>
	);
}

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
	const { visibility, toggle } = useColumnVisibility();
	const visibleCount =
		1 + COLUMN_DEFS.reduce((n, c) => n + (visibility[c.key] ? 1 : 0), 0);

	const items = state.reports.status === "ready" ? state.reports.data.items : [];
	const selected = state.selectedReportIds;
	const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));
	const someSelected = items.some((r) => selected.has(r.id));
	const bulkRunning = state.bulkOperation.status === "running";
	const headerCheckRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (headerCheckRef.current) {
			headerCheckRef.current.indeterminate = !allSelected && someSelected;
		}
	}, [allSelected, someSelected]);

	useEffect(() => {
		inboxRef.current?.scrollTo({ top: 0 });
	}, [state.reportsReplaceCount]);

	const onSelect = (id: string) => {
		dispatch({ type: "REPORT_SELECTED", reportId: id });
	};

	const onToggleAll = () => {
		dispatch({
			type: "SELECTION_SET",
			reportIds: items.map((r) => r.id),
			checked: !someSelected,
		});
	};
	const onToggleRow = (id: string) => {
		dispatch({ type: "SELECTION_TOGGLED", reportId: id });
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

		const hasMore = !!state.reports.data.nextCursor;

		return (
			<table class="inbox-table">
				<thead>
					<tr>
						<th class="th-check">
							<input
								ref={headerCheckRef}
								type="checkbox"
								class="cb"
								aria-label="Select all"
								checked={allSelected}
								disabled={bulkRunning}
								onChange={onToggleAll}
							/>
						</th>
						{visibility.id ? <th>ID</th> : null}
						{visibility.opened ? <th>OPENED</th> : null}
						{visibility.updated ? <th>UPDATED</th> : null}
						{visibility.status ? <th>STATUS</th> : null}
						{visibility.severity ? <th class="th-severity">SEVERITY</th> : null}
						{visibility.asset ? <th class="th-asset">ASSET</th> : null}
						{visibility.title ? <th class="th-title">TITLE</th> : null}
						{visibility.reporter ? <th class="th-person">REPORTER</th> : null}
						{visibility.assignee ? <th class="th-person">ASSIGNEE</th> : null}
						{visibility.reference ? <th>REFERENCE</th> : null}
					</tr>
				</thead>
				<tbody>
					{items.map((r) => {
						const pill = pillFor(r.state);
						const showSelected =
							state.selectedReportId === r.id && state.detailActiveTab !== "bulk";
						const isUnread = !state.readReports[r.id];
						const isBulkSelected = selected.has(r.id);
						const showBulkSelected = isBulkSelected && state.detailActiveTab === "bulk";
						const classes = ["row"];
						if (showSelected) classes.push("selected");
						if (isUnread) classes.push("unread");
						if (showBulkSelected) classes.push("bulk-selected");
						return (
							<tr key={r.id} class={classes.join(" ")} onClick={() => onSelect(r.id)}>
								<td class="check">
									<input
										type="checkbox"
										class="cb"
										aria-label="Select report"
										checked={isBulkSelected}
										disabled={bulkRunning}
										onClick={(e) => e.stopPropagation()}
										onChange={() => onToggleRow(r.id)}
									/>
								</td>
								{visibility.id ? <td class="id">#{r.id}</td> : null}
								{visibility.opened ? (
									<td class="date">{formatRelativeTime(r.created_at)}</td>
								) : null}
								{visibility.updated ? (
									<td class="date">
										{r.last_activity_at ? formatRelativeTime(r.last_activity_at) : ""}
									</td>
								) : null}
								{visibility.status ? (
									<td>
										<span class={`pill ${pill.className}`}>{pill.label}</span>
									</td>
								) : null}
								{visibility.severity ? (
									<td class="severity">
										<SeverityMeter rating={r.severity_rating} />
									</td>
								) : null}
								{visibility.asset ? (
									<td class="asset">
										{r.asset?.asset_identifier ? (
											<AssetIdentifier identifier={r.asset.asset_identifier} />
										) : (
											""
										)}
									</td>
								) : null}
								{visibility.title ? <td class="title">{r.title}</td> : null}
								{visibility.reporter ? (
									<td class="person">{renderPerson(r.reporter)}</td>
								) : null}
								{visibility.assignee ? (
									<td class="person">{renderPerson(r.assignee)}</td>
								) : null}
								{visibility.reference ? (
									<td class="reference">
										{r.issue_tracker_reference_url && r.issue_tracker_reference_id ? (
											<a
												href={r.issue_tracker_reference_url}
												target="_blank"
												rel="noopener noreferrer"
												onClick={(e) => {
													e.stopPropagation();
													e.preventDefault();
													openUrl(r.issue_tracker_reference_url as string);
												}}
											>
												{r.issue_tracker_reference_id}
											</a>
										) : (
											(r.issue_tracker_reference_id ?? "")
										)}
									</td>
								) : null}
							</tr>
						);
					})}
				</tbody>
				<tfoot>
					<tr class="footer-row">
						<td colspan={visibleCount}>
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

	const showColumnsMenu =
		state.reports.status === "ready" && state.reports.data.items.length > 0;

	return (
		<div class="inbox-wrap">
			<main class="inbox" ref={inboxRef}>
				<div
					class={`loading-bar${state.reportsRefreshing ? " active" : ""}`}
					role="progressbar"
					aria-label="Refreshing reports"
					aria-hidden={!state.reportsRefreshing}
				/>
				{body}
			</main>
			{showColumnsMenu ? (
				<div class="inbox-toolbar">
					<ColumnsMenu visibility={visibility} onToggle={toggle} />
				</div>
			) : null}
		</div>
	);
}
