import { useEffect, useRef } from "preact/hooks";
import { comboLabel, SHORTCUTS } from "../shortcuts";

type Props = {
	open: boolean;
	onClose: () => void;
};

// The listing is generated from the SHORTCUTS table, so a shortcut can't be added or rebound
// without this dialog following it.
export function ShortcutsDialog({ open, onClose }: Props) {
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
			class="app-dialog shortcuts-dialog"
			aria-labelledby="shortcuts-title"
			onClose={onClose}
		>
			<div class="dialog-card">
				<header class="settings-head">
					<h1 id="shortcuts-title">Keyboard shortcuts</h1>
					<button type="button" class="settings-close" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				<dl class="shortcut-list">
					{Object.values(SHORTCUTS).map((shortcut) => (
						<div key={shortcut.label} class="shortcut-row">
							<dt>
								{shortcut.keys.map((key, i) => (
									<span key={key}>
										{i > 0 ? <span class="shortcut-or"> or </span> : null}
										<kbd>{comboLabel(shortcut, key)}</kbd>
									</span>
								))}
							</dt>
							<dd>{shortcut.label}</dd>
						</div>
					))}
				</dl>
			</div>
		</dialog>
	);
}
