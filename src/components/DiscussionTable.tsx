import { useEffect } from "preact/hooks";
import { useShortcut } from "../shortcuts";
import { useAppState, useDispatch } from "../state/context";
import { DISCUSSION_LIMIT, loadComments } from "../state/effects";
import { Avatar } from "./Avatar";
import { RelativeTime } from "./RelativeTime";
import { ReportLink } from "./ReportLink";

function scrollRowIntoView(commentId: string) {
	const row = document.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);
	if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
}

/**
 * The newest comments across every synced report, whatever state the report is in, newest first.
 * Entirely derived from the local mirror — the same rows the inbox is built from, expanded by
 * their comments — so there's nothing here to sync or store. Selecting a row opens the report in
 * the shared detail panel, scrolled to the comment that was clicked; that pane stays live, it's
 * only this list that holds still while the view is open.
 */
export function DiscussionTable() {
	const state = useAppState();
	const dispatch = useDispatch();
	const handle = state.filters.programHandle;

	const items = state.comments.status === "ready" ? state.comments.data.items : [];

	// The feed spans every report, so none of the sidebar's filters apply to it (which is why the
	// sidebar is hidden here): load it once the view is open, and reload it on a program change or
	// from the toolbar's refresh button.
	useEffect(() => {
		if (!handle) return;
		loadComments(dispatch, handle);
	}, [handle, dispatch]);

	const onSelect = (reportId: string, activityId: string) => {
		dispatch({ type: "REPORT_SELECTED", reportId, focusActivityId: activityId });
	};

	// j/k walk the feed the same way they walk the inbox: stopping at both ends, and starting at
	// the top when nothing is selected.
	const step = (delta: number) => {
		if (items.length === 0) return;
		const current = items.findIndex((c) => c.id === state.focusActivityId);
		const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), items.length - 1);
		if (next === current) return;
		onSelect(items[next].report_id, items[next].id);
		scrollRowIntoView(items[next].id);
	};
	useShortcut("selectNextReport", () => step(1));
	useShortcut("selectPrevReport", () => step(-1));

	const body = (() => {
		if (!handle) {
			return <div class="placeholder">Select a program to load its comments.</div>;
		}
		if (state.comments.status === "idle" || state.comments.status === "loading") {
			return <div class="placeholder">Loading comments…</div>;
		}
		if (state.comments.status === "error") {
			return (
				<div class="placeholder error">
					<p>{state.comments.error.message}</p>
					<button type="button" class="retry-btn" onClick={() => loadComments(dispatch, handle)}>
						Try again
					</button>
				</div>
			);
		}
		if (items.length === 0) {
			return <div class="placeholder">No comments.</div>;
		}

		return (
			<table class="inbox-table discussion-table">
				<thead>
					<tr>
						<th class="th-id">ID</th>
						<th class="th-comment">Comment</th>
					</tr>
				</thead>
				<tbody>
					{items.map((c) => {
						const selected =
							state.selectedReportId === c.report_id && state.focusActivityId === c.id;
						return (
							<tr
								key={c.id}
								data-comment-id={c.id}
								class={selected ? "row selected" : "row"}
								onClick={() => onSelect(c.report_id, c.id)}
							>
								<td class="id">
									<ReportLink id={c.report_id} />
								</td>
								<td class="comment">
									<div class="comment-meta">
										<Avatar user={c.actor} />
										<span class="comment-author">{c.actor?.username ?? "system"}</span>
										{c.internal ? (
											<span
												class="icon-padlock"
												role="img"
												aria-label="Internal"
											/>
										) : null}
										<span class="comment-time">
											<RelativeTime iso={c.created_at} />
										</span>
									</div>
									<p class="comment-body">{c.message}</p>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		);
	})();

	return (
		<div class="inbox-wrap">
			<div class="inbox-toolbar">
				<div class="toolbar-left">
					{state.comments.status === "ready" ? (
						<span class="toolbar-total">
							{items.length === DISCUSSION_LIMIT
								? `Latest ${DISCUSSION_LIMIT} comments`
								: `${items.length} ${items.length === 1 ? "comment" : "comments"}`}
						</span>
					) : null}
					<div
						class="sync-indicator"
						role="status"
					>
						<span>List refresh paused</span>
					</div>
				</div>
				{handle ? (
					<button
						type="button"
						class="columns-menu-btn"
						aria-label="Refresh comments"
						onClick={() => loadComments(dispatch, handle)}
					>
						↻
					</button>
				) : null}
			</div>
			<main class="inbox">{body}</main>
		</div>
	);
}
