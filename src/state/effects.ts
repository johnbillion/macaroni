import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api/client";
import { ALL_SEVERITY_KEYS, ALL_STATE_KEYS } from "./filters";
import type {
	Action,
	AppError,
	AppState,
	DuplicateInput,
	TriageEvent,
	TriageValidity,
} from "./store";

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

export async function loadSettings(dispatch: Dispatch) {
	try {
		const settings = await api.getSettings();
		dispatch({ type: "SETTINGS_LOADED", settings });
	} catch {
		// Non-fatal — settings fall back to their defaults (everything unset) until the next load.
	}
}

// Persist the triage working directory and reflect it in state. Pass null (or an empty
// string) to clear it back to "unset". Returns an error to the caller for surfacing inline.
export async function setTriageWorkingDir(
	dispatch: Dispatch,
	dir: string | null,
): Promise<AppError | null> {
	try {
		const settings = await api.setTriageWorkingDir(dir);
		dispatch({ type: "TRIAGE_WORKING_DIR_SET", dir: settings.triage_working_dir });
		return null;
	} catch (e) {
		return asError(e);
	}
}

export async function setTriagePrompt(
	dispatch: Dispatch,
	prompt: string | null,
): Promise<AppError | null> {
	try {
		const settings = await api.setTriagePrompt(prompt);
		dispatch({ type: "TRIAGE_PROMPT_SET", prompt: settings.triage_prompt });
		return null;
	} catch (e) {
		return asError(e);
	}
}

export async function logOut(
	dispatch: Dispatch,
	deleteDatabase: boolean,
): Promise<AppError | null> {
	try {
		await api.logOut(deleteDatabase);
		cancelPendingReportsLoad();
		// The reducer resets to the initial (empty) report list, so the next login has to re-issue
		// whatever query it lands on even if it's identical to the one from this session.
		lastIssuedQueryKey = null;
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

// Select the program straight from the local mirror at launch, so the inbox renders off SQLite
// without waiting for the organizations → programs API round trip. Only when the mirror holds
// exactly one program: with several there's no way to know which the user wants, and with none
// there's nothing to show anyway, so both cases defer to the API's pick.
export async function adoptLocalProgram(dispatch: Dispatch) {
	try {
		const handles = await api.listLocalPrograms();
		if (handles.length === 1) {
			dispatch({ type: "LOCAL_PROGRAM_DETECTED", handle: handles[0] });
		}
	} catch {
		// Best-effort — the API path still selects a program a moment later.
	}
}

// Load the asset identifiers seen across a program's synced reports (the sidebar asset filter).
// Derived from the local mirror rather than the organization's assets endpoint: the query filters
// on the identifier, which every report carries, so the API list added a round trip and a
// numeric-id translation without adding anything to filter by. Also called as a background refresh
// when the sync lands more reports.
export async function loadAssets(dispatch: Dispatch, programHandle: string) {
	dispatch({ type: "ASSET_OPTIONS_REQUESTED", programHandle });
	try {
		const assets = await api.listLocalAssets(programHandle);
		dispatch({ type: "ASSET_OPTIONS_SUCCEEDED", programHandle, assets });
	} catch (e) {
		dispatch({ type: "ASSET_OPTIONS_FAILED", programHandle, error: asError(e) });
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

// Load the distinct inboxes seen across a program's synced reports (the sidebar inbox filter).
// Also called as a background refresh when the sync lands more reports — the reducer keeps the
// existing ready list visible during the reload, so there's no flicker.
export async function loadInboxes(dispatch: Dispatch, programHandle: string) {
	dispatch({ type: "INBOX_OPTIONS_REQUESTED", programHandle });
	try {
		const inboxes = await api.listInboxes(programHandle);
		dispatch({ type: "INBOX_OPTIONS_SUCCEEDED", programHandle, inboxes });
	} catch (e) {
		dispatch({ type: "INBOX_OPTIONS_FAILED", programHandle, error: asError(e) });
	}
}

export async function loadReportDetail(dispatch: Dispatch, reportId: string) {
	// Seed the pane from the list summary so it populates immediately. Then show the locally
	// cached full detail (activities/attachments) if the sync has already fetched it — that's
	// the DB-first path, instant and offline-capable. Finally fetch a fresh copy from the API
	// (which also writes through to the DB) and overwrite with it.
	dispatch({ type: "DETAIL_SEEDED", reportId });
	let hadCached = false;
	try {
		const cached = await api.getCachedReport(reportId);
		if (cached) {
			hadCached = true;
			dispatch({ type: "DETAIL_SUCCEEDED", reportId, detail: cached });
		}
	} catch {
		// Non-fatal — fall through to the network fetch.
	}
	try {
		const detail = await api.getReport(reportId);
		dispatch({ type: "DETAIL_SUCCEEDED", reportId, detail });
	} catch (e) {
		// Keep the cached detail on screen if we have it; only surface the error otherwise.
		if (!hadCached) dispatch({ type: "DETAIL_FAILED", reportId, error: asError(e) });
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

const VALID_VALIDITIES = new Set<string>(["valid", "partially-valid", "invalid", "indeterminate"]);

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
	// Asset *identifiers* (e.g. "bbPress Core") — what reports carry and the sidebar selects by.
	assetIdentifiers: string[];
	assignees: string[];
	// Selected inbox ids (see InboxRef.id). Filtered entirely in SQL — there's no HackerOne API
	// to filter reports by inbox.
	inboxIds: string[];
	keyword: string;
	// Match each keyword term at word boundaries only. Always false when keyword is empty,
	// so toggling the checkbox with no search active doesn't change the query key.
	wholeWords: boolean;
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

function reportsQueryKey(query: ReportsQuery): string {
	return JSON.stringify({
		h: query.programHandle,
		s: [...query.states].sort(),
		v: [...query.severities].sort(),
		a: [...query.assetIdentifiers].sort(),
		n: [...query.assignees].sort(),
		i: [...query.inboxIds].sort(),
		k: query.keyword,
		w: query.wholeWords,
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

// Run the current filter set against the local SQLite mirror and install the result. `replace`
// distinguishes a user-initiated query (filter change / manual refresh / first load: scrolls to
// top, may re-pick selection) from a background re-query driven by the sync engine (leaves scroll
// and selection alone). Local queries are instant, so a background refresh skips the loading flash
// and the same-query short-circuit — it must re-run because the underlying data changed.
export async function loadReports(
	dispatch: Dispatch,
	query: ReportsQuery,
	replace = true,
	force = false,
): Promise<void> {
	const key = reportsQueryKey(query);
	if (replace && !force && key === lastIssuedQueryKey) return;
	if (replace) lastIssuedQueryKey = key;
	const myId = ++reportsRequestId;
	if (replace) dispatch({ type: "REPORTS_REQUESTED" });
	try {
		const items = await api.queryReports({
			program_handle: query.programHandle,
			states: query.states,
			severities: query.severities,
			asset_identifiers: query.assetIdentifiers,
			assignees: query.assignees,
			inbox_ids: query.inboxIds,
			keyword: query.keyword || undefined,
			whole_words: query.wholeWords,
		});
		if (myId !== reportsRequestId) return;
		hydrateTriageValidity(
			dispatch,
			items.map((i) => i.id),
		);
		dispatch({ type: "REPORTS_SUCCEEDED", items, replace });
	} catch (e) {
		if (replace && lastIssuedQueryKey === key) lastIssuedQueryKey = null;
		if (myId !== reportsRequestId) return;
		dispatch({ type: "REPORTS_FAILED", error: asError(e) });
	}
}

// Re-run the active query in the background (no loading flash, no scroll/selection reset). Called
// when the sync engine reports the local DB changed.
export async function refreshReports(dispatch: Dispatch, state: AppState) {
	const query = buildReportsQuery(state);
	if (!query) return;
	await loadReports(dispatch, query, false);
}

// Start (or resume) the background sync that mirrors the program into SQLite. Idempotent on the
// Rust side. Best-effort — the app still works off whatever is already in the DB if this fails.
export async function startReportSync(programHandle: string) {
	try {
		await api.startReportSync(programHandle);
	} catch {
		// Best-effort — a failed kick-off just means no fresh data this session.
	}
}

// Refresh the "N synced" total shown in the Topbar when no sync is actively running.
export async function refreshSyncedCount(dispatch: Dispatch, programHandle: string) {
	try {
		const count = await api.syncedReportCount(programHandle);
		dispatch({ type: "SYNCED_COUNT_SET", count });
	} catch {
		// Non-fatal — the indicator just keeps its previous value.
	}
}

// Build the query from the current filter state, applying the "fully-checked group == no
// filter" optimization. Unlike the old API path, the "unrated" severity sentinel is kept — the
// local DB can filter for a null severity_rating.
export function buildReportsQuery(state: AppState): ReportsQuery | null {
	const handle = state.filters.programHandle;
	if (!handle) return null;

	const states = state.filters.states.length === ALL_STATE_KEYS.length ? [] : state.filters.states;
	const severities =
		state.filters.severities.length === ALL_SEVERITY_KEYS.length ? [] : state.filters.severities;

	// Asset selection is by identifier; "all available selected" means no filter.
	const assetOptions = state.assetsByProgram[handle];
	const availableAssets = assetOptions?.status === "ready" ? assetOptions.data : [];
	const assetIdentifiers =
		availableAssets.length > 0 && state.filters.assets.length === availableAssets.length
			? []
			: state.filters.assets;

	// Inbox selection is by id; "all available selected" means no filter, matching the asset facet.
	const inboxOptions = state.inboxesByProgram[handle];
	const availableInboxIds =
		inboxOptions?.status === "ready" ? inboxOptions.data.map((i) => i.id) : [];
	const inboxIds =
		availableInboxIds.length > 0 && state.filters.inboxes.length === availableInboxIds.length
			? []
			: state.filters.inboxes;

	const keyword = state.filters.search.trim();
	return {
		programHandle: handle,
		states,
		severities,
		assetIdentifiers,
		assignees: state.filters.assignees,
		inboxIds,
		keyword,
		wholeWords: keyword.length > 0 && state.filters.searchWholeWords,
	};
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

// Ask Claude whether the selected reports are duplicates of one another. Mirrors runTriage:
// subscribe to the streamed event channel, run the command, and dispatch the final verdict.
export async function runDuplicateCheck(
	dispatch: Dispatch,
	requestId: string,
	reports: DuplicateInput[],
) {
	dispatch({ type: "DUP_CHECK_STARTED" });
	let unlisten: UnlistenFn | null = null;
	try {
		unlisten = await listen<TriageEvent>(`duplicates:event:${requestId}`, (e) => {
			dispatch({ type: "DUP_CHECK_EVENT", event: e.payload });
		});
		const result = await api.runDuplicates(requestId, reports);
		dispatch({ type: "DUP_CHECK_SUCCEEDED", result });
	} catch (e) {
		dispatch({ type: "DUP_CHECK_FAILED", error: asError(e) });
	} finally {
		if (unlisten) unlisten();
	}
}

export async function stopDuplicateCheck(requestId: string) {
	try {
		await api.stopDuplicates(requestId);
	} catch {
		// Best-effort, same as stopTriage.
	}
}

// Delete one of a report's triage new-files from disk and prune it from state. Rethrows so the
// caller can surface a failure (e.g. a permission error) inline next to the file.
export async function deleteTriageFile(dispatch: Dispatch, reportId: string, path: string) {
	const remaining = await api.deleteTriageFile(reportId, path);
	dispatch({ type: "TRIAGE_FILE_DELETED", reportId, remaining });
}
