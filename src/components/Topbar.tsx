import { useEffect, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { markReportsRead } from "../state/effects";
import { Settings } from "./Settings";

function useTheme() {
	const [dark, setDark] = useState<boolean>(() => {
		const stored = localStorage.getItem("macaroni.theme");
		if (stored === "dark") return true;
		if (stored === "light") return false;
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	});
	useEffect(() => {
		document.documentElement.classList.toggle("dark", dark);
		localStorage.setItem("macaroni.theme", dark ? "dark" : "light");
	}, [dark]);
	return { dark, toggle: () => setDark((d) => !d) };
}

export function Topbar() {
	const state = useAppState();
	const dispatch = useDispatch();
	const { toggle } = useTheme();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const programHandle = state.filters.programHandle ?? "—";
	const placement = state.detailPlacement;
	const toggleDetailPlacement = () => {
		const next = placement === "right" ? "bottom" : "right";
		localStorage.setItem("macaroni.detailPlacement", next);
		dispatch({ type: "DETAIL_PLACEMENT_SET", placement: next });
	};

	const unreadLoadedIds =
		state.reports.status === "ready"
			? state.reports.data.items.filter((r) => !state.readReports[r.id]).map((r) => r.id)
			: [];
	const markAllRead = () => markReportsRead(dispatch, unreadLoadedIds);

	return (
		<div class="topbar" data-tauri-drag-region>
			<div class="brand">
				<div class="brand-mark" />
				Macaroni
			</div>
			<div class="crumbs">
				PROGRAM / <b>{programHandle.toUpperCase()}</b> / INBOX
			</div>
			<div class="topbar-stats">
				<div class="tick">
					NEW <b class="pos">—</b>
				</div>
				<div class="tick">
					TRIAGED <b>—</b>
				</div>
				<div class="tick">
					AWAITING REPORTER <b>—</b>
				</div>
			</div>
			<div class="status-cluster">
				<button
					type="button"
					class="theme-toggle"
					aria-label="Mark all loaded reports as read"
					title="Mark all loaded reports as read"
					onClick={markAllRead}
					disabled={unreadLoadedIds.length === 0}
				>
					✓
				</button>
				<button
					type="button"
					class="user-pill user-pill-button"
					title="Settings"
					onClick={() => setSettingsOpen(true)}
				>
					{state.username ?? "—"}
				</button>
				<button
					type="button"
					class="theme-toggle"
					aria-label="Settings"
					title="Settings"
					onClick={() => setSettingsOpen(true)}
				>
					⚙
				</button>
				<button
					type="button"
					class="theme-toggle"
					aria-label="Toggle detail panel position"
					title={
						placement === "right"
							? "Move detail panel to bottom"
							: "Move detail panel to right"
					}
					onClick={toggleDetailPlacement}
				>
					{placement === "right" ? "▥" : "▤"}
				</button>
				<button
					type="button"
					class="theme-toggle"
					aria-label="Toggle theme"
					title="Toggle light/dark"
					onClick={toggle}
				>
					◐
				</button>
			</div>
			<Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
		</div>
	);
}
