import { useEffect, useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { logOut, saveCredentials } from "../state/effects";
import { type AppError, THEME_STORAGE_KEY, type Theme } from "../state/store";
import { LogOutDialog } from "./LogOutDialog";
import { TriagePromptField } from "./TriagePromptField";
import { TriageWorkingDirField } from "./TriageWorkingDirField";

type Props = {
	open: boolean;
	onClose: () => void;
};

const THEME_OPTIONS: { value: Theme; label: string }[] = [
	{ value: "system", label: "Match system" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export function Settings({ open, onClose }: Props) {
	const state = useAppState();
	const dispatch = useDispatch();
	const ref = useRef<HTMLDialogElement>(null);

	const [username, setUsername] = useState("");
	const [token, setToken] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);
	const [confirmingLogOut, setConfirmingLogOut] = useState(false);
	const [error, setError] = useState<AppError | null>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) {
			setUsername(state.username ?? "");
			setToken("");
			setError(null);
			setConfirmingLogOut(false);
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	}, [open, state.username]);

	const onSubmit = async (e: Event) => {
		e.preventDefault();
		if (!username || !token) return;
		setSubmitting(true);
		setError(null);
		const err = await saveCredentials(dispatch, username, token);
		setSubmitting(false);
		if (err) {
			setError(err);
			return;
		}
		onClose();
	};

	const onLogOut = async (deleteDatabase: boolean) => {
		setLoggingOut(true);
		setError(null);
		const err = await logOut(dispatch, deleteDatabase);
		setLoggingOut(false);
		setConfirmingLogOut(false);
		if (err) {
			setError(err);
			return;
		}
		onClose();
	};

	const setTheme = (theme: Theme) => {
		try {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch {}
		dispatch({ type: "THEME_SET", theme });
	};

	const busy = submitting || loggingOut;

	return (
		<>
			<dialog ref={ref} class="app-dialog settings-dialog" onClose={onClose}>
				<form class="settings-card" onSubmit={onSubmit}>
					<header class="settings-head">
						<h1>Settings</h1>
						<button
							type="button"
							class="settings-close"
							aria-label="Close"
							onClick={onClose}
							disabled={busy}
						>
							×
						</button>
					</header>
					<p class="muted">
						Signed in as <b>{state.username ?? "—"}</b>. Credentials are stored in your macOS
						keychain.
					</p>
					<label>
						<span>API username</span>
						<input
							type="text"
							autocomplete="off"
							value={username}
							onInput={(e) => setUsername(e.currentTarget.value)}
							disabled={busy}
						/>
					</label>
					<label>
						<span>API token</span>
						<input
							type="password"
							autocomplete="off"
							placeholder="Enter a new token to update"
							value={token}
							onInput={(e) => setToken(e.currentTarget.value)}
							disabled={busy}
						/>
					</label>
					<hr class="settings-divider" />
					<fieldset class="radio-field">
						<legend>Appearance</legend>
						<div class="radio-row">
							{THEME_OPTIONS.map((option) => (
								<label key={option.value} class="radio-option">
									<input
										type="radio"
										name="theme"
										value={option.value}
										checked={state.theme === option.value}
										onChange={() => setTheme(option.value)}
										disabled={busy}
									/>
									{option.label}
								</label>
							))}
						</div>
					</fieldset>
					<TriageWorkingDirField />
					<TriagePromptField />
					{error && <div class="error">{error.message}</div>}
					<div class="settings-actions">
						<button
							type="button"
							class="button button-danger"
							onClick={() => setConfirmingLogOut(true)}
							disabled={busy}
						>
							{loggingOut ? "Logging out…" : "Log out"}
						</button>
						<button
							type="submit"
							class="button button-primary"
							disabled={busy || !username || !token}
						>
							{submitting ? "Saving…" : "Save"}
						</button>
					</div>
				</form>
			</dialog>
			<LogOutDialog
				open={confirmingLogOut}
				busy={loggingOut}
				onConfirm={onLogOut}
				onCancel={() => {
					if (!loggingOut) setConfirmingLogOut(false);
				}}
			/>
		</>
	);
}
