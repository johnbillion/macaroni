import { useEffect, useRef } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import {
	bootstrap,
	buildReportsQuery,
	debounceLoadReports,
	loadAssets,
	loadPrograms,
	loadReportDetail,
	loadReports,
	loadTeamMembers,
	loadTriage,
	markReportRead,
	pollNewReports,
	refreshReportDetail,
	type ReportsQuery,
} from "../state/effects";
import { CredentialsGate } from "./CredentialsGate";
import { DetailPanel } from "./DetailPanel";
import { InboxTable } from "./InboxTable";
import { Resizer } from "./Resizer";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

const DETAIL_REFRESH_INTERVAL_MS = 20_000;
const NEW_REPORTS_POLL_INTERVAL_MS = 30_000;

export function App() {
	const state = useAppState();
	const dispatch = useDispatch();

	useEffect(() => {
		if (state.credentials === "unknown") {
			bootstrap(dispatch);
		}
	}, [state.credentials, dispatch]);

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
	const searchKey = state.filters.search.trim();

	const firstReportsLoadRef = useRef(true);
	useEffect(() => {
		const query = buildReportsQuery(state);
		if (!query) return;
		if (firstReportsLoadRef.current) {
			firstReportsLoadRef.current = false;
			loadReports(dispatch, query);
			return;
		}
		// Debounce rapid filter toggles so a burst of checkbox clicks only fires one request.
		return debounceLoadReports(dispatch, query);
		// We key on the joined strings so reference identity churn doesn't refetch on every render.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	}, [handle, statesKey, severitiesKey, assetsKey, searchKey, eligibleAssetKey, dispatch]);

	// Selecting a report (whether by click or by the reducer's auto-select on a fresh load)
	// should populate the detail pane. We only react to the selection itself changing —
	// detail/readReports updates are read from the same render's closure and don't re-fire.
	const selectedReportId = state.selectedReportId;
	useEffect(() => {
		if (!selectedReportId) return;
		const existing = state.detail[selectedReportId];
		if (!existing || existing.status === "error") {
			loadReportDetail(dispatch, selectedReportId);
		} else if (existing.status === "ready" && !state.readReports[selectedReportId]) {
			markReportRead(dispatch, selectedReportId);
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
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

	// Poll for newly-filed reports matching the current filters and slot them into the top of
	// the inbox, the way a new email lands at the top of your mailbox. We always poll from the
	// created_at of the newest report on screen so a potentially heavy query only returns the
	// delta. Paused while the window is unfocused, and runs an immediate catch-up on focus so
	// returning to the app surfaces anything filed while away. The inputs (filters + high-water
	// mark) live in a ref so a burst of filter toggles doesn't tear down and rebuild the timer —
	// the interval reads the latest.
	const pollInputsRef = useRef<{
		ready: boolean;
		query: ReportsQuery | null;
		since: string | null;
		boundaryId: string | null;
		replaceCount: number;
		warmupStart: number | null;
	}>({
		ready: false,
		query: null,
		since: null,
		boundaryId: null,
		replaceCount: 0,
		warmupStart: null,
	});
	// Anchor the warmup the moment the main reports query first fires (status leaves "idle",
	// which happens just after the credentials helper unlocks and bootstrap selects a program).
	// Until a full interval has elapsed from that point, polls no-op — so a focus event during
	// the app's first seconds doesn't race the initial load with a redundant delta request.
	if (pollInputsRef.current.warmupStart === null && state.reports.status !== "idle") {
		pollInputsRef.current.warmupStart = Date.now();
	}
	const newest = state.reports.status === "ready" ? state.reports.data.items[0] : undefined;
	pollInputsRef.current = {
		...pollInputsRef.current,
		ready: state.reports.status === "ready",
		query: buildReportsQuery(state),
		since: newest?.created_at ?? null,
		boundaryId: newest?.id ?? null,
		replaceCount: state.reportsReplaceCount,
	};
	useEffect(() => {
		let intervalId: number | null = null;
		const poll = () => {
			const { ready, query, since, boundaryId, replaceCount, warmupStart } = pollInputsRef.current;
			// Skip until a query exists (program selected) and the list is settled — never fire
			// while the initial load is in flight or errored. `since` may still be null here for
			// an empty view, which pollNewReports handles by fetching the first page.
			if (!ready || !query) return;
			// Chill during the startup warmup so the main query has time to settle first.
			if (warmupStart !== null && Date.now() - warmupStart < NEW_REPORTS_POLL_INTERVAL_MS) return;
			pollNewReports(dispatch, query, since, boundaryId, replaceCount);
		};
		const start = () => {
			if (intervalId !== null) return;
			intervalId = window.setInterval(poll, NEW_REPORTS_POLL_INTERVAL_MS);
		};
		const stop = () => {
			if (intervalId !== null) {
				window.clearInterval(intervalId);
				intervalId = null;
			}
		};
		const onFocus = () => {
			poll();
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
