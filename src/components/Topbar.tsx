import { useEffect, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
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

	// ⌘, shortcut for opening preferences.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.metaKey && e.key === ",") {
				e.preventDefault();
				setSettingsOpen(true);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const programHandle = state.filters.programHandle ?? "—";
	const placement = state.detailPlacement;
	const toggleDetailPlacement = () => {
		const next = placement === "right" ? "bottom" : "right";
		localStorage.setItem("macaroni.detailPlacement", next);
		dispatch({ type: "DETAIL_PLACEMENT_SET", placement: next });
	};

	return (
		<div class="topbar" data-tauri-drag-region>
			<div class="brand">Macaroni / {programHandle}</div>
			<div class="status-cluster">
				<button
					type="button"
					class="theme-toggle"
					aria-label="Settings"
					title="Settings (⌘,)"
					onClick={() => setSettingsOpen(true)}
				>
					⚙
				</button>
				<button
					type="button"
					class="theme-toggle"
					aria-label="Toggle detail panel position"
					title={
						placement === "right" ? "Move detail panel to bottom" : "Move detail panel to right"
					}
					onClick={toggleDetailPlacement}
				>
					{placement === "right" ? "▥" : "▤"}
				</button>
				<button
					type="button"
					class="theme-toggle"
					aria-label="Toggle light/dark theme"
					title="Toggle light/dark theme"
					onClick={toggle}
				>
					◐
				</button>
			</div>
			<Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
		</div>
	);
}
