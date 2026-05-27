import { useEffect, useRef } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import {
	bootstrap,
	buildReportsQuery,
	loadAssets,
	loadPrograms,
	loadReports,
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
		const timer = window.setTimeout(() => loadReports(dispatch, query), 1000);
		return () => window.clearTimeout(timer);
		// We key on the joined strings so reference identity churn doesn't refetch on every render.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	}, [handle, statesKey, severitiesKey, assetsKey, eligibleAssetKey, dispatch]);

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
