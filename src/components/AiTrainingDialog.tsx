import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { acknowledgeAiNotice } from "../state/effects";

const DOCS_URL = "https://code.claude.com/docs/en/data-usage";

type Props = {
	open: boolean;
	onConfirm: () => void;
	onCancel: () => void;
};

/**
 * One-time warning shown before the first triage or duplicate-check run: those runs hand report
 * contents to Claude, and whether Anthropic trains on them is an account-level setting the app
 * can't see or change.
 */
export function AiTrainingDialog({ open, onConfirm, onCancel }: Props): JSX.Element {
	const ref = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	}, [open]);

	return (
		<dialog
			ref={ref}
			class="app-dialog confirm-dialog ai-notice-dialog"
			aria-labelledby="ai-notice-title"
			aria-describedby="ai-notice-desc"
			onClose={onCancel}
		>
			<div class="dialog-card">
				<h1 id="ai-notice-title">Report contents are sent to Claude</h1>
				<div id="ai-notice-desc" class="muted">
					<p>
						The AI-powered report triage and the AI-powered duplicate checking sends vulnerability
						report details to Claude Code on this machine. Your own Anthropic account settings
						control whether that data is used for model training.
					</p>
					<p>
						<b>
							Before proceeding, review the data training policy setting in your account to ensure
							that this data is not used for training.
						</b>
					</p>
					<p>
						<a
							href={DOCS_URL}
							target="_blank"
							rel="noopener noreferrer"
							onClick={(e) => {
								e.preventDefault();
								openUrl(DOCS_URL);
							}}
						>
							Claude Code data usage documentation
						</a>
					</p>
				</div>
				<div class="ai-notice-actions">
					<button type="button" class="button" onClick={onCancel} autofocus>
						Cancel
					</button>
					<button type="button" class="button button-primary" onClick={onConfirm}>
						Proceed
					</button>
				</div>
			</div>
		</dialog>
	);
}

/**
 * Gates a run behind {@link AiTrainingDialog} until the notice has been acknowledged. Render
 * `dialog` alongside the trigger and call `guard(run)` in its place.
 */
export function useAiTrainingGate(): {
	guard: (run: () => void) => void;
	dialog: JSX.Element;
} {
	const acknowledged = useAppState().aiNoticeAcknowledged;
	const dispatch = useDispatch();
	// Held rather than re-derived on confirm, so the dialog can gate any caller's run.
	const [pending, setPending] = useState<(() => void) | null>(null);

	const guard = (run: () => void) => {
		if (acknowledged) {
			run();
			return;
		}
		setPending(() => run);
	};

	const confirm = () => {
		const run = pending;
		setPending(null);
		void acknowledgeAiNotice(dispatch);
		run?.();
	};

	return {
		guard,
		dialog: (
			<AiTrainingDialog
				open={pending !== null}
				onConfirm={confirm}
				onCancel={() => setPending(null)}
			/>
		),
	};
}
