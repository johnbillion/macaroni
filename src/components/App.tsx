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
	markReportRead,
} from "../state/effects";
import { CredentialsGate } from "./CredentialsGate";
import { DetailPanel } from "./DetailPanel";
import { InboxTable } from "./InboxTable";
import { Resizer } from "./Resizer";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

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
			? currentAssets.data.filter((a) => a.in_scope).map((a) => a.id).join(",")
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
