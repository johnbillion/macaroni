import { useState } from "preact/hooks";
import { useShortcut } from "../shortcuts";
import { useAppState, useDispatch } from "../state/context";
import { Settings } from "./Settings";
import { ShortcutsDialog } from "./ShortcutsDialog";

export function Topbar() {
	const state = useAppState();
	const dispatch = useDispatch();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);

	useShortcut("openSettings", () => setSettingsOpen(true));
	useShortcut("showShortcuts", () => setShortcutsOpen(true));

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
			</div>
			<Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
			<ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
		</div>
	);
}
