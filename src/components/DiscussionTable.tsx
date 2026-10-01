import { useEffect } from "preact/hooks";
import { useShortcut } from "../shortcuts";
import { useAppState, useDispatch } from "../state/context";
import { DISCUSSION_PAGE_SIZE, loadDiscussion } from "../state/effects";
import { Avatar } from "./Avatar";
import { describeEventAction } from "./activity/renderActivity";
import { AttachmentGallery, Markdown, referencedAttachmentIds } from "./Markdown";
import { RelativeTime } from "./RelativeTime";
import { ReportLink } from "./ReportLink";

// Deliberately not `data-activity-id`: the detail pane scrolls to that attribute with a
// document-wide query, and these rows would shadow the thread entry.
function scrollRowIntoView(activityId: string) {
	const row = document.querySelector(`[data-discussion-id="${CSS.escape(activityId)}"]`);
	if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
}

/**
 * The newest activity across every synced report, whatever state the report is in, newest first:
 * every comment, every state change, plus the events worth following program-wide (lock,
 * mediation, bounties, disclosure — see DISCUSSION_EVENT_KINDS on the Rust side). Entirely
 * derived from the local mirror — the same rows the inbox is built from, expanded by their
 * activities — so there's nothing here to sync or store. Selecting a row opens the report in the
 * shared detail panel, scrolled to the activity that was clicked; that pane stays live, it's only
 * this list that holds still while the view is open.
 */
export function DiscussionTable() {
	const state = useAppState();
	const dispatch = useDispatch();
	const handle = state.filters.programHandle;

	const ready = state.discussion.status === "ready" ? state.discussion.data : null;
	const items = ready?.items ?? [];
	// Refreshes keep whatever depth "load more" has reached rather than snapping back to one page.
	const limit = ready?.limit ?? DISCUSSION_PAGE_SIZE;
	// A full page means there may be more; a short one means the mirror is exhausted.
	const mayHaveMore = ready !== null && items.length >= limit;

	// The feed spans every report, so none of the sidebar's filters apply to it (which is why the
	// sidebar is hidden here): load it once the view is open, and reload it on a program change or
	// from the toolbar's refresh button.
	useEffect(() => {
		if (!handle) return;
		loadDiscussion(dispatch, handle);
	}, [handle, dispatch]);

	const onSelect = (reportId: string, activityId: string) => {
		dispatch({ type: "REPORT_SELECTED", reportId, focusActivityId: activityId });
	};

	// j/k walk the feed the same way they walk the inbox: stopping at both ends, and starting at
	// the top when nothing is selected.
	const step = (delta: number) => {
		if (items.length === 0) return;
		const current = items.findIndex((it) => it.activity.id === state.focusActivityId);
		const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), items.length - 1);
		if (next === current) return;
		onSelect(items[next].report_id, items[next].activity.id);
		scrollRowIntoView(items[next].activity.id);
	};
	useShortcut("selectNextReport", () => step(1));
	useShortcut("selectPrevReport", () => step(-1));

	const body = (() => {
		if (!handle) {
			return <div class="placeholder">Select a program to load its discussion.</div>;
		}
		if (state.discussion.status === "idle" || state.discussion.status === "loading") {
			return <div class="placeholder">Loading discussion…</div>;
		}
		if (state.discussion.status === "error") {
			return (
				<div class="placeholder error">
					<p>{state.discussion.error.message}</p>
					<button type="button" class="retry-btn" onClick={() => loadDiscussion(dispatch, handle)}>
						Try again
					</button>
				</div>
			);
		}
		if (items.length === 0) {
			return <div class="placeholder">No activity.</div>;
		}

		return (
			<>
				<table class="inbox-table discussion-table">
					<thead>
						<tr>
							<th class="th-id">ID</th>
							<th class="th-comment">Activity</th>
						</tr>
					</thead>
					<tbody>
						{items.map(({ report_id, activity: a }) => {
							const selected =
								state.selectedReportId === report_id && state.focusActivityId === a.id;
							const message = a.type === "comment" ? a.message : (a.message ?? "");
							const hasMessage = message.trim().length > 0;
							// Same split as the detail pane's thread: attachments referenced inline via
							// {F<id>} render inside the body, the rest are listed beneath it.
							const attachments = a.type === "comment" ? a.attachments : [];
							const referencedIds = referencedAttachmentIds(message);
							const extraAttachments = attachments.filter((x) => !referencedIds.has(x.id));
							return (
								<tr
									key={a.id}
									data-discussion-id={a.id}
									class={selected ? "row selected" : "row"}
									onClick={() => onSelect(report_id, a.id)}
								>
									<td class="id">
										<ReportLink id={report_id} />
									</td>
									<td class="comment">
										<div class="comment-meta">
											<Avatar user={a.actor} />
											<span class="comment-author">{a.actor?.username ?? "system"}</span>
											{a.type === "event" ? describeEventAction(a) : null}
											{a.internal ? (
												<span class="icon-padlock" role="img" aria-label="Internal" />
											) : null}
											<span class="comment-time">
												<RelativeTime iso={a.created_at} />
											</span>
										</div>
										{hasMessage ? (
											<Markdown source={message} attachments={attachments} class="comment-body" />
										) : null}
										<AttachmentGallery attachments={extraAttachments} class="comment-attachments" />
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				{mayHaveMore ? (
					<div class="load-more">
						<button
							type="button"
							class="retry-btn"
							disabled={ready.pending}
							onClick={() => loadDiscussion(dispatch, handle, limit + DISCUSSION_PAGE_SIZE)}
						>
							{ready.pending ? "Loading…" : `Load ${DISCUSSION_PAGE_SIZE} more`}
						</button>
					</div>
				) : null}
			</>
		);
	})();

	return (
		<div class="inbox-wrap">
			<div class="inbox-toolbar">
				<div class="toolbar-left">
					{state.discussion.status === "ready" ? (
						<span class="toolbar-total">
							{mayHaveMore
								? `Latest ${items.length} items`
								: `${items.length} ${items.length === 1 ? "item" : "items"}`}
						</span>
					) : null}
					<div class="sync-indicator" role="status">
						<span>List refresh paused</span>
					</div>
				</div>
				{handle ? (
					<button
						type="button"
						class="columns-menu-btn"
						aria-label="Refresh discussion"
						onClick={() => loadDiscussion(dispatch, handle, limit)}
					>
						↻
					</button>
				) : null}
			</div>
			<main class="inbox">{body}</main>
		</div>
	);
}
