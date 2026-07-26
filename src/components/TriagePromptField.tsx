import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { useAppState, useDispatch } from "../state/context";
import { setTriagePrompt } from "../state/effects";
import type { AppError } from "../state/store";

export function TriagePromptField() {
	const state = useAppState();
	const dispatch = useDispatch();
	const [defaultPrompt, setDefaultPrompt] = useState<string | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<AppError | null>(null);

	useEffect(() => {
		let cancelled = false;
		api
			.getDefaultTriagePrompt()
			.then((p) => {
				if (!cancelled) setDefaultPrompt(p);
			})
			.catch((e: AppError) => {
				if (!cancelled) setError(e);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const saved = state.triagePrompt ?? defaultPrompt;
	useEffect(() => {
		setDraft(saved);
	}, [saved]);

	const save = async () => {
		if (draft == null) return;
		setBusy(true);
		setError(null);
		const value = draft === defaultPrompt ? null : draft;
		const err = await setTriagePrompt(dispatch, value);
		setBusy(false);
		if (err) setError(err);
	};

	const reset = async () => {
		setBusy(true);
		setError(null);
		const err = await setTriagePrompt(dispatch, null);
		setBusy(false);
		if (err) setError(err);
	};

	const dirty = draft != null && draft !== saved;

	return (
		<div class="prompt-field">
			<label>
				<span>Triage prompt</span>
				<textarea
					class="prompt-field-input"
					rows={10}
					spellcheck={false}
					value={draft ?? ""}
					disabled={busy || draft == null}
					onInput={(e) => setDraft(e.currentTarget.value)}
				/>
			</label>
			<div class="prompt-field-row">
				<span class="prompt-field-status">
					{state.triagePrompt == null ? "Using the default prompt" : "Customised"}
				</span>
				{state.triagePrompt != null ? (
					<button type="button" onClick={reset} disabled={busy}>
						Reset to default
					</button>
				) : null}
				<button type="button" onClick={save} disabled={busy || !dirty}>
					{busy ? "…" : "Save prompt"}
				</button>
			</div>
			{error && <div class="error">{error.message}</div>}
		</div>
	);
}
