import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "preact/hooks";
import { api } from "../api/client";
import { useShortcut } from "../shortcuts";
import { useAppState, useDispatch } from "../state/context";
import {
	adoptLocalProgram,
	bootstrap,
	buildReportsQuery,
	debounceLoadReports,
	loadAssets,
	loadInboxes,
	loadPrograms,
	loadReportDetail,
	loadReports,
	loadSettings,
	loadTeamMembers,
	loadTriage,
	refreshReportDetail,
	refreshReports,
	refreshSyncedCount,
	reloadCachedReportDetail,
	startReportSync,
} from "../state/effects";
import type { SyncStatus } from "../state/store";
import { CredentialsGate } from "./CredentialsGate";
import { DetailPanel } from "./DetailPanel";
import { DiscussionTable } from "./DiscussionTable";
import { InboxTable } from "./InboxTable";
import { Resizer } from "./Resizer";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

const DETAIL_REFRESH_INTERVAL_MS = 20_000;

export function App() {
	const state = useAppState();
	const dispatch = useDispatch();

	useEffect(() => {
		if (state.credentials === "unknown") {
			bootstrap(dispatch);
		}
	}, [state.credentials, dispatch]);

	// Settings are machine-local and independent of credentials, so load them once at startup.
	useEffect(() => {
		loadSettings(dispatch);
	}, [dispatch]);

	// Reports come from the local mirror, so on any launch after the first there's no reason to wait
	// for HackerOne before showing them: pick the program from the DB and the query effect below
	// fires immediately. Runs alongside `bootstrap`, and only ever wins the race on a warm DB.
	useEffect(() => {
		adoptLocalProgram(dispatch);
	}, [dispatch]);

	// Reflect the macOS system accent colour into the theme's --accent / --on-accent CSS
	// variables (buttons, links, selection, controls all derive from them). Applied on launch
	// and re-applied whenever the user changes the accent in System Settings → Appearance.
	useEffect(() => {
		let unlisten: UnlistenFn | null = null;
		const apply = (c: { accent: string; on_accent: string }) => {
			const root = document.documentElement.style;
			root.setProperty("--accent", c.accent);
			root.setProperty("--on-accent", c.on_accent);
		};
		(async () => {
			try {
				apply(await api.getAccentColor());
			} catch {
				// Non-macOS or a read failure: the stylesheet's fallback accent stays in effect.
			}
			unlisten = await listen<{ accent: string; on_accent: string }>("theme:accent-changed", (e) =>
				apply(e.payload),
			);
		})();
		return () => unlisten?.();
	}, []);

	// Light/dark is chosen in Settings; "system" follows the OS appearance live, so the media
	// query stays subscribed rather than being read once.
	useEffect(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const dark = state.theme === "system" ? query.matches : state.theme === "dark";
			document.documentElement.classList.toggle("dark", dark);
		};
		apply();
		if (state.theme !== "system") return;
		query.addEventListener("change", apply);
		return () => query.removeEventListener("change", apply);
	}, [state.theme]);

	useEffect(() => {
		const orgId = state.filters.orgId;
		if (orgId && !state.programsByOrg[orgId]) {
			loadPrograms(dispatch, orgId);
		}
	}, [state.filters.orgId, state.programsByOrg, dispatch]);

	// Asset and inbox filter options are both derived from the program's synced reports, so load them
	// once a program is selected. The sync:changed listener below re-loads them as more reports land.
	useEffect(() => {
		const handle = state.filters.programHandle;
		if (!handle) return;
		if (state.assetsByProgram[handle]) return;
		loadAssets(dispatch, handle);
	}, [state.filters.programHandle, state.assetsByProgram, dispatch]);

	useEffect(() => {
		const handle = state.filters.programHandle;
		if (!handle) return;
		if (state.inboxesByProgram[handle]) return;
		loadInboxes(dispatch, handle);
	}, [state.filters.programHandle, state.inboxesByProgram, dispatch]);

	// Team members are per program and only change when the program changes. We need both the
	// selected handle and the loaded programs list to resolve handle → program id (the API
	// call is keyed on id, but the rest of the app addresses programs by handle).
	useEffect(() => {
		const orgId = state.filters.orgId;
		const handle = state.filters.programHandle;
		if (!orgId || !handle) return;
		if (state.teamMembersByProgram[handle]) return;
		const programs = state.programsByOrg[orgId];
		if (programs?.status !== "ready") return;
		const program = programs.data.find((p) => p.handle === handle);
		if (!program) return;
		loadTeamMembers(dispatch, handle, program.id);
	}, [
		state.filters.orgId,
		state.filters.programHandle,
		state.programsByOrg,
		state.teamMembersByProgram,
		dispatch,
	]);

	const handle = state.filters.programHandle;
	const view = state.view;
	const currentAssets = handle ? state.assetsByProgram[handle] : undefined;
	const availableAssetKey = currentAssets?.status === "ready" ? currentAssets.data.join(",") : "";

	const currentInboxes = handle ? state.inboxesByProgram[handle] : undefined;
	const availableInboxKey =
		currentInboxes?.status === "ready" ? currentInboxes.data.map((i) => i.id).join(",") : "";

	const statesKey = state.filters.states.join(",");
	const severitiesKey = state.filters.severities.join(",");
	const assetsKey = state.filters.assets.join(",");
	const assigneesKey = state.filters.assignees.join(",");
	const inboxesKey = state.filters.inboxes.join(",");
	const searchKey = state.filters.search.trim();
	// Effective only while a search is active — mirrors buildReportsQuery, so toggling the
	// checkbox with an empty search box doesn't re-query.
	const wholeWordsKey = searchKey.length > 0 && state.filters.searchWholeWords;

	// Program selection and the sidebar facet filters (state, severity, asset, assignee) query the
	// local DB immediately — local queries are instant, so there's nothing to debounce. This also
	// runs the initial load once a program is selected. We key on the joined strings so reference
	// identity churn doesn't refetch on every render.
	//
	// The discussion view isn't built from this query, and re-running it there could re-pick the
	// selection out from under the comment being read — so filter changes made while it's open are
	// applied when the inbox comes back (`view` is a dependency, and the query key does the rest).
	useEffect(() => {
		if (view !== "inbox") return;
		const query = buildReportsQuery(state);
		if (!query) return;
		loadReports(dispatch, query);
	}, [
		view,
		handle,
		statesKey,
		severitiesKey,
		assetsKey,
		assigneesKey,
		inboxesKey,
		wholeWordsKey,
		availableAssetKey,
		availableInboxKey,
		dispatch,
	]);

	// The free-text search box is the one filter still debounced, so a burst of keystrokes fires a
	// single query. Skip the initial run — the effect above already issues the first load.
	const firstSearchRef = useRef(true);
	useEffect(() => {
		if (firstSearchRef.current) {
			firstSearchRef.current = false;
			return;
		}
		if (view !== "inbox") return;
		const query = buildReportsQuery(state);
		if (!query) return;
		return debounceLoadReports(dispatch, query);
	}, [searchKey, view, dispatch]);

	// Selecting a report (whether by click or by the reducer's auto-select on a fresh load)
	// should populate the detail pane. We only react to the selection itself changing —
	// detail updates are read from the same render's closure and don't re-fire.
	const selectedReportId = state.selectedReportId;

	// A bulk selection (the inbox checkboxes) puts a hold on every automatic fetch — list and
	// detail both — while the user works through the checked reports.
	const bulkHold = state.selectedReportIds.size > 0;
	// The discussion view holds the list too: its feed is a snapshot of the mirror, and syncing
	// under it would reorder what the user is reading through. The detail pane is not held there,
	// so the report on screen keeps polling and picking up new activity.
	const listRefreshHeld = bulkHold || view === "discussion";
	const detailRefreshHeld = bulkHold;
	const listRefreshHeldRef = useRef(listRefreshHeld);
	listRefreshHeldRef.current = listRefreshHeld;
	const detailRefreshHeldRef = useRef(detailRefreshHeld);
	detailRefreshHeldRef.current = detailRefreshHeld;

	useShortcut(
		"openReport",
		() => openUrl(`https://hackerone.com/reports/${selectedReportId}`),
		selectedReportId !== null,
	);

	useEffect(() => {
		if (!selectedReportId) return;
		const existing = state.detail[selectedReportId];
		if (!existing || existing.status === "error") {
			loadReportDetail(dispatch, selectedReportId);
		} else if (existing.status === "ready" && !detailRefreshHeldRef.current) {
			// Already-loaded detail: refresh it in the background (like the focus catch-up) so
			// switching back to a report surfaces anything that changed while it was off screen.
			refreshReportDetail(dispatch, selectedReportId);
		}
	}, [selectedReportId, dispatch]);

	// A discussion row asks for one specific comment. The snapshot we hold for that report can
	// predate it — only the selected report is polled, so every other one drifts behind the mirror
	// as the sync lands activity — which would leave the pane with nothing to scroll to. Top it up
	// from the mirror, the same blob the feed was built from, so the comment is there straight away
	// rather than after the background refresh returns.
	const focusActivityId = state.focusActivityId;
	useEffect(() => {
		if (!selectedReportId || !focusActivityId) return;
		const existing = state.detail[selectedReportId];
		// Anything but a settled snapshot means a load is already in flight with the comment in it.
		if (existing?.status !== "ready" || state.detailPending[selectedReportId]) return;
		if (existing.data.activities.some((a) => a.id === focusActivityId)) return;
		reloadCachedReportDetail(dispatch, selectedReportId);
	}, [selectedReportId, focusActivityId, dispatch]);

	// Hydrate any saved triage for the selected report so the AI Triage tab shows immediately.
	// Skip if we already have a running/ready/loading entry — overwriting would clobber events.
	useEffect(() => {
		if (!selectedReportId) return;
		const existing = state.triage[selectedReportId];
		if (existing) return;
		loadTriage(dispatch, selectedReportId);
	}, [selectedReportId, state.triage, dispatch]);

	// Poll the selected report in the background so new activity / detail changes surface
	// without the user having to reselect. The reducer diffs the result against the prior
	// snapshot and emits toasts. Polling pauses when the window loses focus (no point
	// hitting the API while the user is in another app) and fires an immediate catch-up
	// refresh when focus returns, so the toasts surface whatever happened while away. It also
	// pauses entirely while a bulk selection holds refreshes off. The discussion view doesn't hold
	// it: the report on screen there is being read like any other, and its comments keep arriving.
	useEffect(() => {
		if (!selectedReportId || detailRefreshHeld) return;
		let intervalId: number | null = null;
		const start = () => {
			if (intervalId !== null) return;
			intervalId = window.setInterval(() => {
				refreshReportDetail(dispatch, selectedReportId);
			}, DETAIL_REFRESH_INTERVAL_MS);
		};
		const stop = () => {
			if (intervalId !== null) {
				window.clearInterval(intervalId);
				intervalId = null;
			}
		};
		const onFocus = () => {
			refreshReportDetail(dispatch, selectedReportId);
			start();
		};
		if (document.hasFocus()) start();
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", stop);
		return () => {
			stop();
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", stop);
		};
	}, [selectedReportId, detailRefreshHeld, dispatch]);

	// The report list is now driven by the local SQLite mirror. Kick off the background sync
	// whenever the selected program changes — on the Rust side it fetches the initial open-reports
	// page, then runs an incremental update catch-up (reports touched since we last synced) and,
	// on a fresh DB, a full open+closed backfill. It's idempotent, so re-firing is harmless.
	//
	// We also re-fire on window focus: returning to the app runs the incremental catch-up, which
	// pulls in anything created or updated on HackerOne while we were away and slots it into the
	// inbox (via the sync:changed → re-query path). If a sync is already running the Rust guard
	// makes the focus call a no-op.
	//
	// Held off entirely while a bulk selection is active, refocus included — that's the case where
	// the user has just been closing those reports on hackerone.com — and while the discussion view
	// is open. Releasing either re-runs this effect, which is what performs the deferred catch-up.
	useEffect(() => {
		if (!handle || listRefreshHeld) return;
		const sync = () => {
			startReportSync(handle);
			refreshSyncedCount(dispatch, handle);
		};
		sync();
		window.addEventListener("focus", sync);
		return () => window.removeEventListener("focus", sync);
	}, [handle, listRefreshHeld, dispatch]);

	// React to sync progress: `sync:changed` means the local DB moved, so re-run the active query
	// in the background (no scroll/selection reset); `sync:status` feeds the Topbar indicator. A
	// ref holds the latest state so the changed-listener rebuilds the query from current filters.
	const stateRef = useRef(state);
	stateRef.current = state;
	// Set when a sync:changed arrived while the list was held, so the release applies it once
	// instead of leaving the list stale until the next sync.
	const deferredSyncChangeRef = useRef(false);
	const applySyncChange = () => {
		refreshReports(dispatch, stateRef.current);
		const h = stateRef.current.filters.programHandle;
		if (h) {
			refreshSyncedCount(dispatch, h);
			// New reports may carry assets or inboxes not yet in the sidebar lists — re-derive.
			loadAssets(dispatch, h);
			loadInboxes(dispatch, h);
		}
	};
	const applySyncChangeRef = useRef(applySyncChange);
	applySyncChangeRef.current = applySyncChange;
	useEffect(() => {
		let unlistenChanged: UnlistenFn | null = null;
		let unlistenStatus: UnlistenFn | null = null;
		(async () => {
			unlistenChanged = await listen("sync:changed", () => {
				if (listRefreshHeldRef.current) {
					deferredSyncChangeRef.current = true;
					return;
				}
				applySyncChangeRef.current();
			});
			unlistenStatus = await listen<SyncStatus>("sync:status", (e) => {
				dispatch({ type: "SYNC_STATUS", status: e.payload });
			});
		})();
		return () => {
			unlistenChanged?.();
			unlistenStatus?.();
		};
	}, [dispatch]);

	// Releasing the list hold — last checkbox unticked, selection cleared, or the inbox coming back
	// — applies the sync:changed that arrived while it was held. The sync kick-off itself resumes
	// via its own effect re-running.
	const wasListHeldRef = useRef(listRefreshHeld);
	useEffect(() => {
		const wasHeld = wasListHeldRef.current;
		wasListHeldRef.current = listRefreshHeld;
		if (listRefreshHeld || !wasHeld) return;
		if (deferredSyncChangeRef.current) {
			deferredSyncChangeRef.current = false;
			applySyncChangeRef.current();
		}
	}, [listRefreshHeld]);

	// Releasing the detail hold fetches a fresh copy of the selected report, whose poll was off for
	// the duration. The poll resumes via its own effect re-running.
	const wasDetailHeldRef = useRef(detailRefreshHeld);
	useEffect(() => {
		const wasHeld = wasDetailHeldRef.current;
		wasDetailHeldRef.current = detailRefreshHeld;
		if (detailRefreshHeld || !wasHeld) return;
		if (selectedReportId) refreshReportDetail(dispatch, selectedReportId);
	}, [detailRefreshHeld, selectedReportId, dispatch]);

	useEffect(() => {
		const onResize = () => {
			dispatch({
				type: "VIEWPORT_RESIZED",
				width: window.innerWidth,
				height: window.innerHeight,
			});
		};
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [dispatch]);

	useEffect(() => {
		localStorage.setItem("macaroni.panelSizes", JSON.stringify(state.panelSizes));
	}, [state.panelSizes]);

	// Persist the accumulated assignee filter options so the sidebar list survives a restart —
	// the reducer returns the same reference when nothing new was learned, so this only writes
	// when a report with a previously-unseen assignee lands.
	useEffect(() => {
		localStorage.setItem(
			"macaroni.assigneeOptions",
			JSON.stringify(state.assigneeOptionsByProgram),
		);
	}, [state.assigneeOptionsByProgram]);

	if (state.credentials === "unknown") {
		// We couldn't even determine whether credentials exist — typically the user dismissed
		// the macOS keychain unlock prompt. Surface the error with a way to retry rather than
		// hanging on "Starting…" forever.
		if (state.bootstrap.status === "error") {
			return (
				<div class="gate" data-tauri-drag-region>
					<div class="gate-card">
						<h1>Couldn't start Macaroni</h1>
						<div class="error">{state.bootstrap.error.message}</div>
						<button type="button" onClick={() => bootstrap(dispatch)}>
							Retry
						</button>
					</div>
				</div>
			);
		}
		return (
			<div class="placeholder" data-tauri-drag-region>
				Starting…
			</div>
		);
	}
	if (state.credentials === "missing") {
		return <CredentialsGate />;
	}

	const bottom = state.detailPlacement === "bottom";
	const appClass = bottom ? "app detail-bottom" : "app";
	const appStyle: Record<string, string> = {
		"--detail-w": `${state.panelSizes.detailRight}px`,
		"--detail-h": `${state.panelSizes.detailBottom}px`,
	};
	return (
		<>
			<Topbar />
			<div class={appClass} style={appStyle}>
				{/* Every sidebar facet filters the inbox query, which the discussion feed isn't built
				    from — so it goes away with the inbox table. */}
				{view === "inbox" ? <Sidebar /> : null}
				<div class="app-main">
					{view === "discussion" ? <DiscussionTable /> : <InboxTable />}
					{bottom ? (
						<Resizer panel="detailBottom" orientation="horizontal" invert />
					) : (
						<Resizer panel="detailRight" invert />
					)}
					<DetailPanel />
				</div>
			</div>
		</>
	);
}
