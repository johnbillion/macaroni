import { api } from "../api/client";
import { ALL_SEVERITY_KEYS, ALL_STATE_KEYS, CLOSED_STATES } from "./filters";
import type { Action, AppError, AppState, AssetRef } from "./store";

const CLOSED_STATE_KEYS = new Set(CLOSED_STATES.map((s) => s.key));

type Dispatch = (action: Action) => void;

function asError(e: unknown): AppError {
	if (e && typeof e === "object" && "kind" in e && "message" in e) {
		return e as AppError;
	}
	return { kind: "other", message: String(e) };
}

export async function bootstrap(dispatch: Dispatch) {
	dispatch({ type: "BOOTSTRAP_REQUESTED" });
	try {
		const { has_credentials, username } = await api.credentialsStatus();
		dispatch({ type: "CREDENTIALS_KNOWN", present: has_credentials, username });
		if (!has_credentials) return;
		const orgs = await api.listOrganizations();
		dispatch({ type: "BOOTSTRAP_SUCCEEDED", orgs });
	} catch (e) {
		const error = asError(e);
		if (error.kind === "unauthorized") {
			dispatch({ type: "CREDENTIALS_KNOWN", present: false, username: null });
		}
		dispatch({ type: "BOOTSTRAP_FAILED", error });
	}
}

export async function saveCredentials(
	dispatch: Dispatch,
	username: string,
	token: string,
): Promise<AppError | null> {
	try {
		await api.credentialsSave(username, token);
		dispatch({ type: "CREDENTIALS_SAVED", username });
		await bootstrap(dispatch);
		return null;
	} catch (e) {
		return asError(e);
	}
}

export async function clearCredentials(dispatch: Dispatch): Promise<AppError | null> {
	try {
		await api.credentialsClear();
		dispatch({ type: "CREDENTIALS_CLEARED" });
		return null;
	} catch (e) {
		return asError(e);
	}
}

export async function loadPrograms(dispatch: Dispatch, orgId: string) {
	dispatch({ type: "PROGRAMS_REQUESTED", orgId });
	try {
		const programs = await api.listPrograms(orgId);
		dispatch({ type: "PROGRAMS_SUCCEEDED", orgId, programs });
	} catch (e) {
		dispatch({ type: "PROGRAMS_FAILED", orgId, error: asError(e) });
	}
}

export async function loadAssets(dispatch: Dispatch, orgId: string) {
	dispatch({ type: "ASSETS_REQUESTED", orgId });
	try {
		const assets = await api.listAssets(orgId);
		dispatch({ type: "ASSETS_SUCCEEDED", orgId, assets });
	} catch (e) {
		dispatch({ type: "ASSETS_FAILED", orgId, error: asError(e) });
	}
}

export async function loadTeamMembers(
	dispatch: Dispatch,
	programHandle: string,
	programId: string,
) {
	dispatch({ type: "TEAM_MEMBERS_REQUESTED", programHandle });
	try {
		const members = await api.listProgramMembers(programId);
		dispatch({ type: "TEAM_MEMBERS_SUCCEEDED", programHandle, members });
	} catch (e) {
		dispatch({ type: "TEAM_MEMBERS_FAILED", programHandle, error: asError(e) });
	}
}

export async function loadReportDetail(dispatch: Dispatch, reportId: string) {
	dispatch({ type: "DETAIL_REQUESTED", reportId });
	try {
		const detail = await api.getReport(reportId);
		dispatch({ type: "DETAIL_SUCCEEDED", reportId, detail });
		markReportRead(dispatch, reportId);
	} catch (e) {
		dispatch({ type: "DETAIL_FAILED", reportId, error: asError(e) });
	}
}

// Background refresh — does NOT flip the detail into a loading state, and silently swallows
// errors so a transient network blip doesn't blow away the currently-rendered report. The
// reducer handles the diff between the prior snapshot and the freshly fetched one.
export async function refreshReportDetail(dispatch: Dispatch, reportId: string) {
	try {
		const detail = await api.getReport(reportId);
		dispatch({ type: "DETAIL_REFRESHED", reportId, detail });
	} catch {
		// Best-effort — the next poll will retry.
	}
}

export async function markReportRead(dispatch: Dispatch, reportId: string) {
	dispatch({ type: "REPORT_MARKED_READ", reportId });
	try {
		await api.markReportRead(reportId);
	} catch {
		// Best-effort — UI already reflects the optimistic update.
	}
}

export async function markReportsRead(dispatch: Dispatch, reportIds: string[]) {
	if (reportIds.length === 0) return;
	dispatch({ type: "REPORTS_MARKED_READ", reportIds });
	try {
		await api.markReportsRead(reportIds);
	} catch {
		// Best-effort — UI already reflects the optimistic update.
	}
}

async function hydrateReadIds(dispatch: Dispatch, ids: string[]) {
	if (ids.length === 0) return;
	try {
		const readIds = await api.getReadIds(ids);
		dispatch({ type: "READ_IDS_LOADED", ids: readIds });
	} catch {
		// Non-fatal: report list still renders; everything just looks unread.
	}
}

export type ReportsQuery = {
	programHandle: string;
	states: string[];
	severities: string[];
	assetIds: string[];
	keyword: string;
};

// Monotonic counter so a later loadReports call can invalidate any in-flight earlier one.
// Tauri's invoke doesn't cancel the underlying HTTP request, but the stale response is
// dropped before dispatch, which is the same observable behaviour as cancellation.
let reportsRequestId = 0;

// Module-scoped so any caller (filter checkboxes, search box, etc.) can cancel a pending
// debounced load — e.g. the search input's onSubmit fires immediately and needs to stop
// the trailing debounce from re-firing the same query.
let pendingDebounceTimer: number | null = null;

// Key of the last query handed to loadReports. Used to short-circuit no-op requests when
// the user lands back on the same filter set (e.g. type-then-backspace, toggle-all twice,
// HMR replay). Cleared on failure so a retry of the same query still goes out.
let lastIssuedQueryKey: string | null = null;

function reportsQueryKey(query: ReportsQuery, pageCursor: string | undefined): string {
	return JSON.stringify({
		h: query.programHandle,
		s: [...query.states].sort(),
		v: [...query.severities].sort(),
		a: [...query.assetIds].sort(),
		k: query.keyword,
		c: pageCursor ?? null,
	});
}

export function debounceLoadReports(
	dispatch: Dispatch,
	query: ReportsQuery,
	delayMs = 1000,
): () => void {
	cancelPendingReportsLoad();
	pendingDebounceTimer = window.setTimeout(() => {
		pendingDebounceTimer = null;
		loadReports(dispatch, query);
	}, delayMs);
	return cancelPendingReportsLoad;
}

export function cancelPendingReportsLoad() {
	if (pendingDebounceTimer !== null) {
		window.clearTimeout(pendingDebounceTimer);
		pendingDebounceTimer = null;
	}
}

export async function loadReports(dispatch: Dispatch, query: ReportsQuery, pageCursor?: string) {
	const key = reportsQueryKey(query, pageCursor);
	if (key === lastIssuedQueryKey) return;
	lastIssuedQueryKey = key;
	const myId = ++reportsRequestId;
	const append = pageCursor !== undefined;
	dispatch({ type: "REPORTS_REQUESTED", append });
	try {
		const { items, next_cursor } = await api.listReports({
			program_handle: query.programHandle,
			states: query.states,
			severities: query.severities,
			asset_ids: query.assetIds,
			keyword: query.keyword || undefined,
			page_cursor: pageCursor,
		});
		if (myId !== reportsRequestId) return;
		hydrateReadIds(
			dispatch,
			items.map((i) => i.id),
		);
		const closedIds = items.filter((i) => CLOSED_STATE_KEYS.has(i.state)).map((i) => i.id);
		markReportsRead(dispatch, closedIds);
		dispatch({
			type: "REPORTS_SUCCEEDED",
			items,
			nextCursor: next_cursor ?? undefined,
			append,
		});
	} catch (e) {
		if (lastIssuedQueryKey === key) lastIssuedQueryKey = null;
		if (myId !== reportsRequestId) return;
		dispatch({ type: "REPORTS_FAILED", error: asError(e), append });
	}
}

// Build the query from the current filter state, applying the "fully-checked group == no
// filter" optimization in the same way as the App-level fetch effect.
export function buildReportsQuery(state: AppState): ReportsQuery | null {
	const handle = state.filters.programHandle;
	if (!handle) return null;

	const orgId = state.filters.orgId;
	const currentAssets = orgId ? state.assetsByOrg[orgId] : undefined;
	const eligibleAssetIds =
		currentAssets?.status === "ready"
			? currentAssets.data.filter((a) => a.in_scope).map((a) => a.id)
			: undefined;

	const states = state.filters.states.length === ALL_STATE_KEYS.length ? [] : state.filters.states;
	const severities =
		state.filters.severities.length === ALL_SEVERITY_KEYS.length
			? []
			: state.filters.severities.filter((s) => s !== "unrated");
	const assetIds =
		eligibleAssetIds && state.filters.assets.length === eligibleAssetIds.length
			? []
			: state.filters.assets;

	return {
		programHandle: handle,
		states,
		severities,
		assetIds,
		keyword: state.filters.search.trim(),
	};
}

export async function loadMoreReports(dispatch: Dispatch, state: AppState) {
	if (state.reports.status !== "ready") return;
	const cursor = state.reports.data.nextCursor;
	if (!cursor) return;
	const query = buildReportsQuery(state);
	if (!query) return;
	await loadReports(dispatch, query, cursor);
}

// Mirrors the reportsRequestId cancellation idiom: a monotonic counter so a later
// runBulkAssetUpdate call invalidates an earlier one, and a flag the UI flips via
// cancelBulkUpdate to stop further iterations after the in-flight request resolves.
let bulkRunId = 0;
let bulkCancelFlag = false;

function shouldAbortBatch(error: AppError): boolean {
	// 401/403 will fail identically for every remaining report (same token, same group).
	// Stop early rather than blasting N identical errors.
	return error.kind === "unauthorized" || error.kind === "forbidden";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function runBulkAssetUpdate(dispatch: Dispatch, reportIds: string[], asset: AssetRef) {
	const myId = ++bulkRunId;
	bulkCancelFlag = false;
	dispatch({ type: "BULK_STARTED", total: reportIds.length });

	for (const id of reportIds) {
		if (bulkCancelFlag || myId !== bulkRunId) break;
		dispatch({ type: "BULK_ITEM_BEGAN", reportId: id });
		try {
			await api.updateReportAsset(id, asset.id);
			if (myId !== bulkRunId) return;
			dispatch({ type: "BULK_ITEM_SUCCEEDED", reportId: id, asset });
		} catch (e) {
			if (myId !== bulkRunId) return;
			const error = asError(e);
			dispatch({ type: "BULK_ITEM_FAILED", reportId: id, error });
			if (shouldAbortBatch(error)) {
				bulkCancelFlag = true;
				break;
			}
			if (error.kind === "rate_limited") {
				await delay(2000);
			}
		}
	}
	dispatch({ type: "BULK_FINISHED", cancelled: bulkCancelFlag });
}

export function cancelBulkUpdate() {
	bulkCancelFlag = true;
}
