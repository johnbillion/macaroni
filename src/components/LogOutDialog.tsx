import { useEffect, useRef } from "preact/hooks";

type Props = {
	open: boolean;
	busy: boolean;
	// Called with whether the local report database should be deleted along with the credentials.
	onConfirm: (deleteDatabase: boolean) => void;
	onCancel: () => void;
};

export function LogOutDialog({ open, busy, onConfirm, onCancel }: Props) {
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
			class="app-dialog confirm-dialog"
			aria-labelledby="logout-title"
			aria-describedby="logout-desc"
			onCancel={(e) => {
				// Escape must not pull the dialog out from under an in-flight log out.
				if (busy) e.preventDefault();
			}}
			onClose={onCancel}
		>
			<div class="dialog-card">
				<h1 id="logout-title">Log out</h1>
				<p id="logout-desc" class="muted">
					The local database holds every synced report. Deleting it frees the space; keeping it
					means the next login starts with the reports already mirrored.
				</p>
				<div class="confirm-actions">
					<button
						type="button"
						class="button button-danger"
						onClick={() => onConfirm(true)}
						disabled={busy}
					>
						Log out fully
					</button>
					<button type="button" class="button" onClick={() => onConfirm(false)} disabled={busy}>
						Log out but retain local database
					</button>
					<button type="button" class="button" onClick={onCancel} disabled={busy} autofocus>
						Cancel
					</button>
				</div>
			</div>
		</dialog>
	);
}
