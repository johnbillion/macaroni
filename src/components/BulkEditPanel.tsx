import { useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { cancelBulkUpdate, runBulkAssetUpdate } from "../state/effects";
import type { AppError, Asset, AssetRef, BulkFailure } from "../state/store";
import { AssetIdentifier } from "./AssetIdentifier";

const NO_CHANGE = "__no_change__";

function assetSortKey(identifier: string): string {
	return identifier.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
}

function formatBulkError(error: AppError): string {
	switch (error.kind) {
		case "unauthorized":
			return "Authentication failed — re-check your API token.";
		case "forbidden":
			return "Permission denied — your token's group may lack full Reports access.";
		case "rate_limited":
			return "Rate limited by HackerOne.";
		case "network":
			return error.message || "Network error.";
		case "not_found":
			return "Report not found.";
		default:
			return error.message || "Unknown error.";
	}
}

export function BulkEditPanel() {
	const state = useAppState();
	const bulk = state.bulkOperation;
	if (bulk.status === "running") return <BulkRunning />;
	if (bulk.status === "done") return <BulkDone />;
	return <BulkIdle />;
}

function BulkIdle() {
	const state = useAppState();
	const dispatch = useDispatch();
	const orgId = state.filters.orgId;
	const assetsState = orgId ? state.assetsByOrg[orgId] : undefined;
	const assets: Asset[] =
		assetsState?.status === "ready"
			? assetsState.data
					.filter((a) => a.in_scope)
					.slice()
					.sort((a, b) => assetSortKey(a.identifier).localeCompare(assetSortKey(b.identifier)))
			: [];

	const [pickedAssetId, setPickedAssetId] = useState<string>(NO_CHANGE);
	const selectedIds = [...state.selectedReportIds];
	const count = selectedIds.length;
	const confirmRef = useRef<HTMLDialogElement>(null);

	const onExit = () => dispatch({ type: "SELECTION_CLEARED" });

	const onSubmit = () => {
		if (pickedAssetId === NO_CHANGE) return;
		confirmRef.current?.showModal();
	};

	const onConfirm = () => {
		const picked = assets.find((a) => a.id === pickedAssetId);
		if (!picked) return;
		const assetRef: AssetRef = {
			id: picked.id,
			asset_identifier: picked.identifier,
			asset_type: picked.asset_type,
		};
		confirmRef.current?.close();
		runBulkAssetUpdate(dispatch, selectedIds, assetRef);
	};

	const canSubmit = pickedAssetId !== NO_CHANGE && count > 0;

	return (
		<div class="bulk-panel">
			<div class="bulk-head">
				<h2 class="bulk-title">
					Editing {count} {count === 1 ? "report" : "reports"}
				</h2>
			</div>

			<div class="bulk-field">
				<div class="bulk-field-h">Change asset</div>
				<label class="bulk-radio">
					<input
						type="radio"
						name="bulk-asset"
						value={NO_CHANGE}
						checked={pickedAssetId === NO_CHANGE}
						onChange={() => setPickedAssetId(NO_CHANGE)}
					/>
					<span class="bulk-radio-label-muted">No change</span>
				</label>
				{assets.length === 0 ? (
					<div class="bulk-radio-muted">No assets available.</div>
				) : (
					assets.map((a) => (
						<label key={a.id} class="bulk-radio">
							<input
								type="radio"
								name="bulk-asset"
								value={a.id}
								checked={pickedAssetId === a.id}
								onChange={() => setPickedAssetId(a.id)}
							/>
							<span>
								<AssetIdentifier identifier={a.identifier} />
							</span>
						</label>
					))
				)}
			</div>

			<div class="bulk-callout" role="note">
				Bulk editing isn't connected to the HackerOne API yet. Submitting won't change anything on
				real reports.
			</div>

			<div class="bulk-actions">
				<button type="button" class="bulk-btn bulk-btn-secondary" onClick={onExit}>
					Exit bulk editing
				</button>
				<button
					type="button"
					class="bulk-btn bulk-btn-primary"
					onClick={onSubmit}
					disabled={!canSubmit}
				>
					Update {count} {count === 1 ? "report" : "reports"}
				</button>
			</div>

			<dialog ref={confirmRef} class="app-dialog bulk-confirm">
				<form method="dialog">
					<p class="bulk-confirm-msg">
						About to change the asset on {count} {count === 1 ? "report" : "reports"}. This can't be
						undone.
					</p>
					<div class="bulk-confirm-actions">
						<button
							type="button"
							class="bulk-btn bulk-btn-secondary"
							value="cancel"
							onClick={() => confirmRef.current?.close()}
						>
							Cancel
						</button>
						<button type="button" class="bulk-btn bulk-btn-primary" onClick={onConfirm}>
							Confirm
						</button>
					</div>
				</form>
			</dialog>
		</div>
	);
}

function BulkRunning() {
	const state = useAppState();
	const dispatch = useDispatch();
	const bulk = state.bulkOperation;
	if (bulk.status !== "running") return null;
	const onCancel = () => {
		cancelBulkUpdate();
		dispatch({ type: "BULK_CANCEL_REQUESTED" });
	};
	return (
		<div class="bulk-panel">
			<div class="bulk-head">
				<h2 class="bulk-title">Updating reports</h2>
			</div>
			<div class="bulk-progress">
				<progress value={bulk.completed} max={bulk.total} />
				<div class="bulk-progress-text">
					{bulk.completed} / {bulk.total}
					{bulk.currentReportId ? ` — updating #${bulk.currentReportId}…` : ""}
				</div>
			</div>
			{bulk.failed.length > 0 ? <FailureList failures={bulk.failed} /> : null}
			<div class="bulk-actions">
				<button
					type="button"
					class="bulk-btn bulk-btn-secondary"
					onClick={onCancel}
					disabled={bulk.cancelRequested}
				>
					{bulk.cancelRequested ? "Cancelling…" : "Cancel"}
				</button>
			</div>
		</div>
	);
}

function BulkDone() {
	const state = useAppState();
	const dispatch = useDispatch();
	const bulk = state.bulkOperation;
	if (bulk.status !== "done") return null;
	const onRetry = () => dispatch({ type: "BULK_RETRY_FAILED" });
	const onDismiss = () => dispatch({ type: "BULK_RESULT_DISMISSED" });
	const parts: string[] = [];
	parts.push(`${bulk.succeeded} updated`);
	if (bulk.failed.length > 0) parts.push(`${bulk.failed.length} failed`);
	const unrun = bulk.total - bulk.succeeded - bulk.failed.length;
	if (bulk.cancelled && unrun > 0) parts.push(`${unrun} cancelled`);
	return (
		<div class="bulk-panel">
			<div class="bulk-head">
				<h2 class="bulk-title">Bulk update complete</h2>
				<div class="bulk-summary">{parts.join(", ")}</div>
			</div>
			{bulk.failed.length > 0 ? <FailureList failures={bulk.failed} /> : null}
			<div class="bulk-actions">
				<button type="button" class="bulk-btn bulk-btn-secondary" onClick={onDismiss}>
					Done
				</button>
				{bulk.failed.length > 0 ? (
					<button type="button" class="bulk-btn bulk-btn-primary" onClick={onRetry}>
						Retry failed {bulk.failed.length === 1 ? "report" : "reports"}
					</button>
				) : null}
			</div>
		</div>
	);
}

function FailureList({ failures }: { failures: BulkFailure[] }) {
	return (
		<div class="bulk-failures">
			<div class="bulk-field-h">Failures ({failures.length})</div>
			<ul class="bulk-failure-list">
				{failures.map((f) => (
					<li key={f.reportId} class="bulk-failure">
						<span class="bulk-failure-id">#{f.reportId}</span>
						<span class="bulk-failure-msg">{formatBulkError(f.error)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
