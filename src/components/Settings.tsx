import { useEffect, useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { clearCredentials, saveCredentials } from "../state/effects";
import type { AppError } from "../state/store";

type Props = {
	open: boolean;
	onClose: () => void;
};

export function Settings({ open, onClose }: Props) {
	const state = useAppState();
	const dispatch = useDispatch();
	const ref = useRef<HTMLDialogElement>(null);

	const [username, setUsername] = useState("");
	const [token, setToken] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);
	const [error, setError] = useState<AppError | null>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) {
			setUsername(state.username ?? "");
			setToken("");
			setError(null);
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

	const onLogOut = async () => {
		setLoggingOut(true);
		setError(null);
		const err = await clearCredentials(dispatch);
		setLoggingOut(false);
		if (err) {
			setError(err);
			return;
		}
		onClose();
	};

	const busy = submitting || loggingOut;

	return (
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
				{error && <div class="error">{error.message}</div>}
				<div class="settings-actions">
					<button type="button" class="settings-logout" onClick={onLogOut} disabled={busy}>
						{loggingOut ? "Logging out…" : "Log out"}
					</button>
					<button type="submit" disabled={busy || !username || !token}>
						{submitting ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
