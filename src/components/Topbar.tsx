import { useEffect, useState } from "preact/hooks";
import { useAppState } from "../state/context";
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
	const { toggle } = useTheme();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const programHandle = state.filters.programHandle ?? "—";

	return (
		<div class="topbar">
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
