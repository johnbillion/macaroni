import { api } from "../api/client";
import type { Action, AppError } from "./store";

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

export async function loadReports(dispatch: Dispatch, query: ReportsQuery) {
	const myId = ++reportsRequestId;
	dispatch({ type: "REPORTS_REQUESTED" });
	try {
		const { items, next_cursor } = await api.listReports({
			program_handle: query.programHandle,
			states: query.states,
			severities: query.severities,
			asset_ids: query.assetIds,
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
		});
	} catch (e) {
		if (myId !== reportsRequestId) return;
		dispatch({ type: "REPORTS_FAILED", error: asError(e) });
	}
}
