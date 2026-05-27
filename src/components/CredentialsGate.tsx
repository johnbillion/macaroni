import { useState } from "preact/hooks";
import { useDispatch } from "../state/context";
import { saveCredentials } from "../state/effects";
import type { AppError } from "../state/store";

export function CredentialsGate() {
	const dispatch = useDispatch();
	const [username, setUsername] = useState("");
	const [token, setToken] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<AppError | null>(null);

	const onSubmit = async (e: Event) => {
		e.preventDefault();
		if (!username || !token) return;
		setSubmitting(true);
		setError(null);
		const err = await saveCredentials(dispatch, username, token);
		setSubmitting(false);
		if (err) setError(err);
	};

	return (
		<div class="gate" data-tauri-drag-region>
			<form class="gate-card" onSubmit={onSubmit}>
				<h1>HackerOne credentials</h1>
				<p class="muted">Stored in your macOS keychain. Required for all API calls.</p>
				<label>
					<span>API username</span>
					<input
						type="text"
						autocomplete="off"
						value={username}
						onInput={(e) => setUsername(e.currentTarget.value)}
						disabled={submitting}
					/>
				</label>
				<label>
					<span>API token</span>
					<input
						type="password"
						autocomplete="off"
						value={token}
						onInput={(e) => setToken(e.currentTarget.value)}
						disabled={submitting}
					/>
				</label>
				{error && <div class="error">{error.message}</div>}
				<button type="submit" disabled={submitting || !username || !token}>
					{submitting ? "Validating…" : "Save"}
				</button>
			</form>
		</div>
	);
}
