import { useState } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import { setTriageWorkingDir } from "../state/effects";
import type { AppError } from "../state/store";

// Directory picker for the triage working directory — the folder the Rust side spawns `claude`
// in for AI-assisted triage. Reused by both the Settings dialog and the Triage tab (the tab
// surfaces it when nothing's been configured yet). Opens the OS-native folder picker rather
// than a custom control, then persists the choice via the Rust side.
export function TriageWorkingDirField() {
	const state = useAppState();
	const dispatch = useDispatch();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<AppError | null>(null);

	const dir = state.triageWorkingDir;

	const choose = async () => {
		setBusy(true);
		setError(null);
		try {
			const picked = await api.pickDirectory();
			// Null means the user cancelled the native dialog — leave the current value alone.
			if (picked !== null) {
				const err = await setTriageWorkingDir(dispatch, picked);
				if (err) setError(err);
			}
		} catch (e) {
			setError(e as AppError);
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		setError(null);
		const err = await setTriageWorkingDir(dispatch, null);
		setBusy(false);
		if (err) setError(err);
	};

	return (
		<label class="dir-field">
			<span>Triage working directory</span>
			<div class="dir-field-row">
				<span class={`dir-field-path${dir ? "" : " dir-field-unset"}`}>{dir ?? "Not set"}</span>
				<button type="button" class="button" onClick={choose} disabled={busy}>
					{busy ? "…" : "Choose…"}
				</button>
				{dir ? (
					<button type="button" class="button button-danger" onClick={clear} disabled={busy}>
						Clear
					</button>
				) : null}
			</div>
			{error && <div class="error">{error.message}</div>}
		</label>
	);
}
