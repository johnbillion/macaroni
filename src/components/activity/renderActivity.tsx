import type { Activity } from "../../state/store";
import { pillFor } from "../../utils/pill";
import { formatRelativeTime } from "../../utils/time";
import { Avatar } from "../Avatar";
import { Markdown } from "../Markdown";

function humanizeKind(kind: string): string {
	return kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * If the event represents a state change, return the new state name (matching
 * the H1 state vocabulary used by pillFor). Otherwise null.
 *
 * H1 uses `activity-bug-<state>` types for every state transition, so once we
 * strip the `bug-` prefix what remains lines up with our pill keys.
 */
function bugStateFromKind(kind: string): string | null {
	if (!kind.startsWith("bug-")) return null;
	return kind.slice("bug-".length);
}

/**
 * Decide whether an activity should be rendered on the program/team side
 * (right-aligned, "out") or the reporter side (left-aligned, "in").
 *
 * Heuristic — refine here as we learn more about edge cases:
 *   - Internal comments are always program-side (the reporter never sees them).
 *   - Anyone who isn't the original reporter is program-side. State changes
 *     and comments are both attributed via `actor`, and reporters can perform
 *     state changes on their own reports too (e.g. closing as duplicate), so
 *     the actor-vs-reporter check applies to events as well as comments.
 *   - If we don't know who the reporter is, default to reporter-side so we
 *     don't mis-attribute their comments to the program.
 */
export function isProgramSide(activity: Activity, reporterId: string | null): boolean {
	if (activity.internal) return true;
	if (!reporterId) return false;
	return activity.actor?.id !== reporterId;
}

export function renderActivity(activity: Activity, reporterId: string | null) {
	const isComment = activity.type === "comment";
	const message = isComment ? activity.message : (activity.message ?? "");
	const hasMessage = message.trim().length > 0;
	const newState = !isComment ? bugStateFromKind(activity.kind) : null;

	// Non-state-change events with no message body collapse to a one-line tick.
	if (!isComment && !newState && !hasMessage) {
		return (
			<div key={activity.id} class="event-tick">
				<span>
					<b>{humanizeKind(activity.kind)}</b>
					{activity.actor && <> · {activity.actor.username}</>}
				</span>
				<span class="event-time">{formatRelativeTime(activity.created_at)}</span>
			</div>
		);
	}

	const author = activity.actor?.username ?? "system";
	const isReporter = reporterId !== null && activity.actor?.id === reporterId;
	const side = isProgramSide(activity, reporterId) ? "out" : "in";
	const classes = ["msg", side, activity.internal ? "internal" : ""].filter(Boolean).join(" ");
	const pill = newState ? pillFor(newState) : null;

	return (
		<div key={activity.id} class={classes}>
			<div class="msg-meta">
				{activity.internal && <span class="msg-internal-flag">INTERNAL</span>}
				<Avatar user={activity.actor} />
				<span class="msg-author">{author}</span>
				{isReporter && <span class="msg-reporter-flag">REPORTER</span>}
				{pill ? (
					<>
						<span class="msg-event-action">changed status to</span>
						<span class={`pill ${pill.className}`}>{pill.label}</span>
					</>
				) : !isComment ? (
					<span class="msg-event-kind">{humanizeKind(activity.kind)}</span>
				) : null}
				<span class="msg-time">{formatRelativeTime(activity.created_at)}</span>
			</div>
			{hasMessage && <Markdown source={message} class="msg-bubble" />}
		</div>
	);
}
