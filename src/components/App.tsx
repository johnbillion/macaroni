import { useEffect } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { bootstrap, loadPrograms, loadStructuredScopes } from "../state/effects";
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
		const handle = state.filters.programHandle;
		if (!orgId || !handle) return;
		const orgPrograms = state.programsByOrg[orgId];
		if (orgPrograms?.status !== "ready") return;
		const program = orgPrograms.data.find((p) => p.handle === handle);
		if (!program) return;
		if (state.scopesByProgram[program.id]) return;
		loadStructuredScopes(dispatch, program.id);
	}, [
		state.filters.orgId,
		state.filters.programHandle,
		state.programsByOrg,
		state.scopesByProgram,
		dispatch,
	]);

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
