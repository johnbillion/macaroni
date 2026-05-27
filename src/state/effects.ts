import { api } from "../api/client";
import { ALL_SEVERITY_KEYS, ALL_STATE_KEYS } from "./filters";
import type { Action, AppError, AppState } from "./store";

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
};

// Monotonic counter so a later loadReports call can invalidate any in-flight earlier one.
// Tauri's invoke doesn't cancel the underlying HTTP request, but the stale response is
// dropped before dispatch, which is the same observable behaviour as cancellation.
let reportsRequestId = 0;

export async function loadReports(
	dispatch: Dispatch,
	query: ReportsQuery,
	pageCursor?: string,
) {
	const myId = ++reportsRequestId;
	const append = pageCursor !== undefined;
	dispatch({ type: "REPORTS_REQUESTED", append });
	try {
		const { items, next_cursor } = await api.listReports({
			program_handle: query.programHandle,
			states: query.states,
			severities: query.severities,
			asset_ids: query.assetIds,
			page_cursor: pageCursor,
		});
		if (myId !== reportsRequestId) return;
		hydrateReadIds(
			dispatch,
			items.map((i) => i.id),
		);
		dispatch({
			type: "REPORTS_SUCCEEDED",
			items,
			nextCursor: next_cursor ?? undefined,
			append,
		});
	} catch (e) {
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

	const states =
		state.filters.states.length === ALL_STATE_KEYS.length ? [] : state.filters.states;
	const severities =
		state.filters.severities.length === ALL_SEVERITY_KEYS.length
			? []
			: state.filters.severities.filter((s) => s !== "unrated");
	const assetIds =
		eligibleAssetIds && state.filters.assets.length === eligibleAssetIds.length
			? []
			: state.filters.assets;

	return { programHandle: handle, states, severities, assetIds };
}

export async function loadMoreReports(dispatch: Dispatch, state: AppState) {
	if (state.reports.status !== "ready") return;
	const cursor = state.reports.data.nextCursor;
	if (!cursor) return;
	const query = buildReportsQuery(state);
	if (!query) return;
	await loadReports(dispatch, query, cursor);
}
