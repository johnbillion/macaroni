import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import { buildReportsQuery, loadReports, startReportSync } from "../state/effects";
import type { AppError, AssigneeRef, UserRef } from "../state/store";
import { formatBounty } from "../utils/money";
import { pillFor } from "../utils/pill";
import { formatRelativeTime } from "../utils/time";
import { formatTitle } from "../utils/title";
import { AssetIdentifier } from "./AssetIdentifier";
import { Avatar } from "./Avatar";
import { ReportLink } from "./ReportLink";
import { SeverityMeter } from "./SeverityMeter";
import { Spinner } from "./Spinner";
import { ValidityBadge } from "./TriagePanel";

const COLUMN_DEFS = [
	{ key: "id", label: "ID", defaultVisible: true },
	{ key: "opened", label: "Opened", defaultVisible: true },
	{ key: "updated", label: "Updated", defaultVisible: false },
	{ key: "status", label: "Status", defaultVisible: true },
	{ key: "severity", label: "Severity", defaultVisible: false },
	{ key: "asset", label: "Asset", defaultVisible: true },
	{ key: "inboxes", label: "Inbox", defaultVisible: false },
	{ key: "title", label: "Title", defaultVisible: true },
	{ key: "triage", label: "Triage", defaultVisible: true },
	{ key: "reporter", label: "Reporter", defaultVisible: false },
	{ key: "assignee", label: "Assignee", defaultVisible: false },
	{ key: "reference", label: "Reference", defaultVisible: false },
	{ key: "bounty", label: "Bounty", defaultVisible: false },
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
	const [visibility, setVisibility] = useState<Record<ColumnKey, boolean>>(loadColumnVisibility);
	useEffect(() => {
		localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibility));
	}, [visibility]);
	const toggle = (key: ColumnKey) => setVisibility((v) => ({ ...v, [key]: !v[key] }));
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

	const items = state.reports.status === "ready" ? state.reports.data.items : [];
	const selected = state.selectedReportIds;
	const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));
	const someSelected = items.some((r) => selected.has(r.id));
	const selectionTabActive = state.detailActiveTab === "duplicates";
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

	const rangeAnchorRef = useRef<string | null>(null);

	const onToggleAll = () => {
		rangeAnchorRef.current = null;
		dispatch({
			type: "SELECTION_SET",
			reportIds: items.map((r) => r.id),
			checked: !someSelected,
		});
	};
	const onToggleRow = (id: string) => {
		rangeAnchorRef.current = id;
		dispatch({ type: "SELECTION_TOGGLED", reportId: id });
	};

	// Shift-click extends from the last checkbox toggled to this one, applying the state the clicked
	// checkbox is heading for across the whole range. Handled on click rather than change because
	// only the mouse event carries the modifier key; preventing the default stops the checkbox
	// toggling itself, so the dispatch below is the only thing that moves the selection.
	const onRowCheckClick = (e: MouseEvent, id: string) => {
		if (!e.shiftKey) return;
		const anchorId = rangeAnchorRef.current;
		if (anchorId === null || anchorId === id) return;
		const anchor = items.findIndex((r) => r.id === anchorId);
		const target = items.findIndex((r) => r.id === id);
		if (anchor === -1 || target === -1) return;
		e.preventDefault();
		// Shift-clicking otherwise drags a text selection across the intervening rows.
		window.getSelection()?.removeAllRanges();
		rangeAnchorRef.current = id;
		const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
		dispatch({
			type: "SELECTION_SET",
			reportIds: items.slice(from, to + 1).map((r) => r.id),
			checked: !selected.has(id),
		});
	};

	const onRetryReports = () => {
		const query = buildReportsQuery(state);
		if (query) loadReports(dispatch, query);
	};

	// Manual refresh: re-query the local DB (bypassing the same-query short-circuit) and kick the
	// background sync so a fresh pull from HackerOne lands too.
	const onRefreshReports = () => {
		const query = buildReportsQuery(state);
		if (!query) return;
		loadReports(dispatch, query, true, true);
		startReportSync(query.programHandle);
	};

	const [downloading, setDownloading] = useState(false);
	const onDownloadReports = async () => {
		if (items.length === 0 || downloading) return;
		// Download only the checked reports when any are selected; otherwise all.
		const toDownload = someSelected ? items.filter((r) => selected.has(r.id)) : items;
		if (toDownload.length === 0) return;
		setDownloading(true);
		try {
			const entries = toDownload.map((r) => ({
				filename: `${r.id}.md`,
				contents: r.vulnerability_information ?? "",
			}));
			await api.saveZipFile(entries, "reports.zip");
		} finally {
			setDownloading(false);
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

		return (
			<table class="inbox-table">
				<thead>
					<tr>
						<th class="th-check">
							<label class="check-label">
								<input
									ref={headerCheckRef}
									type="checkbox"
									class="cb"
									aria-label="Select all"
									checked={allSelected}
									onChange={onToggleAll}
								/>
							</label>
						</th>
						{visibility.id ? <th class="th-id">ID</th> : null}
						{visibility.opened ? <th>Opened</th> : null}
						{visibility.updated ? <th>Updated</th> : null}
						{visibility.status ? <th>Status</th> : null}
						{visibility.severity ? <th class="th-severity">Severity</th> : null}
						{visibility.asset ? <th class="th-asset">Asset</th> : null}
						{visibility.inboxes ? <th class="th-inboxes">Inbox</th> : null}
						{visibility.title ? <th class="th-title">Title</th> : null}
						{visibility.triage ? <th class="th-triage">Triage</th> : null}
						{visibility.reporter ? <th class="th-person">Reporter</th> : null}
						{visibility.assignee ? <th class="th-person">Assignee</th> : null}
						{visibility.reference ? <th>Reference</th> : null}
						{visibility.bounty ? <th class="th-bounty">Bounty</th> : null}
					</tr>
				</thead>
				<tbody>
					{items.map((r) => {
						const pill = pillFor(r.state);
						const showSelected = state.selectedReportId === r.id && !selectionTabActive;
						const isMultiSelected = selected.has(r.id);
						const showMultiSelected = isMultiSelected && selectionTabActive;
						const classes = ["row"];
						if (showSelected) classes.push("selected");
						if (showMultiSelected) classes.push("multi-selected");
						return (
							<tr
								key={r.id}
								class={classes.join(" ")}
								onClick={(e) => {
									// Clicks inside the select-report label toggle the checkbox; don't also open the report.
									if ((e.target as HTMLElement).closest(".check-label")) return;
									onSelect(r.id);
								}}
							>
								<td class="check">
									<label class="check-label">
										<input
											type="checkbox"
											class="cb"
											aria-label="Select report"
											checked={isMultiSelected}
											onClick={(e) => onRowCheckClick(e, r.id)}
											onChange={() => onToggleRow(r.id)}
										/>
									</label>
								</td>
								{visibility.id ? (
									<td class="id">
										<ReportLink id={r.id} />
									</td>
								) : null}
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
								{visibility.inboxes ? (
									<td class="inboxes">
										{(() => {
											// Hide the program's built-in `default` inbox — it's named after the
											// program and adds no information beyond the selected program.
											const inboxes = r.inboxes.filter((inbox) => inbox.kind !== "default");
											if (inboxes.length === 0) return "";
											return (
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
											);
										})()}
									</td>
								) : null}
								{visibility.title ? <td class="title">{formatTitle(r.title)}</td> : null}
								{visibility.triage ? (
									<td class="triage-cell">
										{(() => {
											// In-flight run takes precedence over any previously saved validity.
											if (state.triage[r.id]?.status === "running") {
												return <Spinner class="triage-cell-spinner" />;
											}
											const v = state.triageValidityByReport[r.id];
											if (v === undefined) return null;
											if (v === null) return <span class="triage-cell-empty">—</span>;
											return <ValidityBadge validity={v} />;
										})()}
									</td>
								) : null}
								{visibility.reporter ? <td class="person">{renderPerson(r.reporter)}</td> : null}
								{visibility.assignee ? <td class="person">{renderPerson(r.assignee)}</td> : null}
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
								{visibility.bounty ? (
									<td class="bounty">
										{r.bounty ? (
											formatBounty(r.bounty)
										) : r.bounty_ineligible ? (
											<span class="bounty-ineligible">Not eligible</span>
										) : (
											""
										)}
									</td>
								) : null}
							</tr>
						);
					})}
				</tbody>
			</table>
		);
	})();

	const showColumnsMenu = state.reports.status === "ready" && state.reports.data.items.length > 0;
	const canRefresh = !!buildReportsQuery(state);

	return (
		<div class="inbox-wrap">
			{showColumnsMenu || canRefresh ? (
				<div class="inbox-toolbar">
					{showColumnsMenu ? (
						<span class="toolbar-total">
							{items.length} {items.length === 1 ? "report" : "reports"}
						</span>
					) : null}
					{canRefresh ? (
						<button
							type="button"
							class="columns-menu-btn"
							aria-label="Refresh reports"
							onClick={onRefreshReports}
						>
							↻
						</button>
					) : null}
					{showColumnsMenu ? (
						<button
							type="button"
							class="columns-menu-btn"
							aria-label="Download reports"
							onClick={onDownloadReports}
							disabled={downloading}
						>
							⤓
						</button>
					) : null}
					{showColumnsMenu ? <ColumnsMenu visibility={visibility} onToggle={toggle} /> : null}
				</div>
			) : null}
			<main class="inbox" ref={inboxRef}>
				{body}
			</main>
		</div>
	);
}
