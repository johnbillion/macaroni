import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api/client";
import { ALL_SEVERITY_KEYS, ALL_STATE_KEYS, CLOSED_STATES } from "./filters";
import type {
	Action,
	AppError,
	AppState,
	AssetRef,
	TriageEvent,
	TriageValidity,
} from "./store";

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

const VALID_VALIDITIES = new Set<string>([
	"valid",
	"partially-valid",
	"invalid",
	"indeterminate",
]);

async function hydrateTriageValidity(dispatch: Dispatch, ids: string[]) {
	if (ids.length === 0) return;
	try {
		const rows = await api.listTriageValidity(ids);
		const entries = rows.map((r) => ({
			id: r.id,
			validity:
				r.validity && VALID_VALIDITIES.has(r.validity) ? (r.validity as TriageValidity) : null,
		}));
		dispatch({ type: "TRIAGE_VALIDITY_LOADED", entries });
	} catch {
		// Non-fatal: the inbox column just stays empty.
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

export async function loadReports(
	dispatch: Dispatch,
	query: ReportsQuery,
	pageCursor?: string,
	force = false,
) {
	const key = reportsQueryKey(query, pageCursor);
	if (!force && key === lastIssuedQueryKey) return;
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
		const ids = items.map((i) => i.id);
		hydrateReadIds(dispatch, ids);
		hydrateTriageValidity(dispatch, ids);
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

// Poll for reports created after `sinceCreatedAt` (the created_at of the newest report already
// on screen) and prepend any new ones. Best-effort like refreshReportDetail: it never flips the
// list into a loading state and swallows errors so a transient blip leaves the inbox untouched.
// `replaceCount` is forwarded so the reducer can drop the result if a filter change replaced the
// list while this was in flight. A single page (50) of new reports is plenty for a 30s cadence;
// if more than that ever arrive between polls the older ones surface on the next manual reload.
//
// `sinceCreatedAt` is null when the current view is empty (a filter that matches nothing yet) —
// there's no high-water mark to poll from, so we fetch the first page outright. The reducer's
// dedupe means this harmlessly re-confirms an empty result until the first matching report lands.
//
// `boundaryId` is the id of the report whose created_at we polled from. HackerOne's
// created_at__gt is inclusive of the exact boundary timestamp (it stores sub-ms precision but
// returns ms-truncated created_at), so that report comes back in every response. We drop it by
// id — never by timestamp, which would also discard a genuinely-new report sharing the boundary's
// millisecond. The reducer's dedupe-by-id is the final backstop.
export async function pollNewReports(
	dispatch: Dispatch,
	query: ReportsQuery,
	sinceCreatedAt: string | null,
	boundaryId: string | null,
	replaceCount: number,
) {
	try {
		const { items: fetched } = await api.listReports({
			program_handle: query.programHandle,
			states: query.states,
			severities: query.severities,
			asset_ids: query.assetIds,
			keyword: query.keyword || undefined,
			since_created_at: sinceCreatedAt ?? undefined,
		});
		const items = boundaryId ? fetched.filter((i) => i.id !== boundaryId) : fetched;
		if (items.length === 0) return;
		const ids = items.map((i) => i.id);
		hydrateReadIds(dispatch, ids);
		hydrateTriageValidity(dispatch, ids);
		const closedIds = items.filter((i) => CLOSED_STATE_KEYS.has(i.state)).map((i) => i.id);
		markReportsRead(dispatch, closedIds);
		dispatch({ type: "REPORTS_POLLED", items, replaceCount });
	} catch {
		// Best-effort — the next poll will retry.
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

export async function loadTriage(dispatch: Dispatch, reportId: string) {
	dispatch({ type: "TRIAGE_LOAD_REQUESTED", reportId });
	try {
		const result = await api.getTriage(reportId);
		dispatch({ type: "TRIAGE_LOAD_SUCCEEDED", reportId, result });
	} catch (e) {
		// Treat a load failure as "no saved triage" — surfacing an error here would block the
		// user from starting a fresh run, which is more useful than reporting the read miss.
		dispatch({ type: "TRIAGE_LOAD_SUCCEEDED", reportId, result: null });
		void e;
	}
}

export async function runTriage(dispatch: Dispatch, reportId: string, prompt: string) {
	dispatch({ type: "TRIAGE_RUN_STARTED", reportId });
	let unlisten: UnlistenFn | null = null;
	try {
		unlisten = await listen<TriageEvent>(`triage:event:${reportId}`, (e) => {
			dispatch({ type: "TRIAGE_EVENT", reportId, event: e.payload });
		});
		const result = await api.runTriage(reportId, prompt);
		dispatch({ type: "TRIAGE_RUN_SUCCEEDED", reportId, result });
	} catch (e) {
		dispatch({ type: "TRIAGE_RUN_FAILED", reportId, error: asError(e) });
	} finally {
		if (unlisten) unlisten();
	}
}

export async function stopTriage(reportId: string) {
	try {
		await api.stopTriage(reportId);
	} catch {
		// Best-effort — if the signal fails (process already gone, etc.) the normal
		// completion path will surface whatever state the run ended in.
	}
}
