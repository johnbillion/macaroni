import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import {
	bootstrap,
	buildReportsQuery,
	debounceLoadReports,
	loadAssets,
	loadPrograms,
	loadReportDetail,
	loadReports,
	loadSettings,
	loadTeamMembers,
	loadTriage,
	refreshReportDetail,
	refreshReports,
	refreshSyncedCount,
	startReportSync,
} from "../state/effects";
import type { SyncStatus } from "../state/store";
import { CredentialsGate } from "./CredentialsGate";
import { DetailPanel } from "./DetailPanel";
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

	useEffect(() => {
		const orgId = state.filters.orgId;
		if (orgId && !state.programsByOrg[orgId]) {
			loadPrograms(dispatch, orgId);
		}
	}, [state.filters.orgId, state.programsByOrg, dispatch]);

	useEffect(() => {
		const orgId = state.filters.orgId;
		if (!orgId) return;
		if (state.assetsByOrg[orgId]) return;
		loadAssets(dispatch, orgId);
	}, [state.filters.orgId, state.assetsByOrg, dispatch]);

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

	const orgId = state.filters.orgId;
	const handle = state.filters.programHandle;
	const currentAssets = orgId ? state.assetsByOrg[orgId] : undefined;
	const eligibleAssetKey =
		currentAssets?.status === "ready"
			? currentAssets.data
					.filter((a) => a.in_scope)
					.map((a) => a.id)
					.join(",")
			: "";

	const statesKey = state.filters.states.join(",");
	const severitiesKey = state.filters.severities.join(",");
	const assetsKey = state.filters.assets.join(",");
	const assigneesKey = state.filters.assignees.join(",");
	const searchKey = state.filters.search.trim();

	// Program selection and the sidebar facet filters (state, severity, asset, assignee) query the
	// local DB immediately — local queries are instant, so there's nothing to debounce. This also
	// runs the initial load once a program is selected. We key on the joined strings so reference
	// identity churn doesn't refetch on every render.
	useEffect(() => {
		const query = buildReportsQuery(state);
		if (!query) return;
		loadReports(dispatch, query);
	}, [handle, statesKey, severitiesKey, assetsKey, assigneesKey, eligibleAssetKey, dispatch]);

	// The free-text search box is the one filter still debounced, so a burst of keystrokes fires a
	// single query. Skip the initial run — the effect above already issues the first load.
	const firstSearchRef = useRef(true);
	useEffect(() => {
		if (firstSearchRef.current) {
			firstSearchRef.current = false;
			return;
		}
		const query = buildReportsQuery(state);
		if (!query) return;
		return debounceLoadReports(dispatch, query);
	}, [searchKey, dispatch]);

	// Selecting a report (whether by click or by the reducer's auto-select on a fresh load)
	// should populate the detail pane. We only react to the selection itself changing —
	// detail updates are read from the same render's closure and don't re-fire.
	const selectedReportId = state.selectedReportId;
	useEffect(() => {
		if (!selectedReportId) return;
		const existing = state.detail[selectedReportId];
		if (!existing || existing.status === "error") {
			loadReportDetail(dispatch, selectedReportId);
		} else if (existing.status === "ready") {
			// Already-loaded detail: refresh it in the background (like the focus catch-up) so
			// switching back to a report surfaces anything that changed while it was off screen.
			refreshReportDetail(dispatch, selectedReportId);
		}
	}, [selectedReportId, dispatch]);

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
	// refresh when focus returns, so the toasts surface whatever happened while away.
	useEffect(() => {
		if (!selectedReportId) return;
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
	}, [selectedReportId, dispatch]);

	// The report list is now driven by the local SQLite mirror. Kick off the background sync
	// whenever the selected program changes — on the Rust side it fetches the initial open-reports
	// page, then runs an incremental update catch-up (reports touched since we last synced) and,
	// on a fresh DB, a full open+closed backfill. It's idempotent, so re-firing is harmless.
	//
	// We also re-fire on window focus: returning to the app runs the incremental catch-up, which
	// pulls in anything created or updated on HackerOne while we were away and slots it into the
	// inbox (via the sync:changed → re-query path). If a sync is already running the Rust guard
	// makes the focus call a no-op.
	useEffect(() => {
		if (!handle) return;
		const sync = () => {
			startReportSync(handle);
			refreshSyncedCount(dispatch, handle);
		};
		sync();
		window.addEventListener("focus", sync);
		return () => window.removeEventListener("focus", sync);
	}, [handle, dispatch]);

	// React to sync progress: `sync:changed` means the local DB moved, so re-run the active query
	// in the background (no scroll/selection reset); `sync:status` feeds the Topbar indicator. A
	// ref holds the latest state so the changed-listener rebuilds the query from current filters.
	const stateRef = useRef(state);
	stateRef.current = state;
	useEffect(() => {
		let unlistenChanged: UnlistenFn | null = null;
		let unlistenStatus: UnlistenFn | null = null;
		(async () => {
			unlistenChanged = await listen("sync:changed", () => {
				refreshReports(dispatch, stateRef.current);
				const h = stateRef.current.filters.programHandle;
				if (h) refreshSyncedCount(dispatch, h);
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
				<Sidebar />
				<div class="app-main">
					<InboxTable />
					{bottom ? (
						<Resizer
							panel="detailBottom"
							label="Resize detail panel height"
							orientation="horizontal"
							invert
						/>
					) : (
						<Resizer panel="detailRight" label="Resize detail panel width" invert />
					)}
					<DetailPanel />
				</div>
			</div>
		</>
	);
}
