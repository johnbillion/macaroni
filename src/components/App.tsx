import { useEffect } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { bootstrap, loadPrograms } from "../state/effects";
import { CredentialsGate } from "./CredentialsGate";
import { DetailPanel } from "./DetailPanel";
import { InboxTable } from "./InboxTable";
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

	if (state.credentials === "unknown") {
		return <div class="placeholder">Starting…</div>;
	}
	if (state.credentials === "missing") {
		return <CredentialsGate />;
	}

	return (
		<>
			<Topbar />
			<div class="app">
				<Sidebar />
				<InboxTable />
				<DetailPanel />
			</div>
		</>
	);
}
