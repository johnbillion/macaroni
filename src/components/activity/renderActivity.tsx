import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "preact";
import type { Activity } from "../../state/store";
import { pillFor } from "../../utils/pill";
import { formatRelativeTime } from "../../utils/time";
import { Avatar } from "../Avatar";
import { Markdown } from "../Markdown";

type EventActivity = Extract<Activity, { type: "event" }>;

function humanizeKind(kind: string): string {
	return kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Render a verb-phrase describing what happened in a non-comment event,
 * pulling in kind-specific fields (invitee, scope names, weakness, etc.).
 * Returns null for kinds we don't have a custom phrasing for, so callers
 * can fall back to a humanized kind label.
 */
function describeEvent(activity: EventActivity): JSX.Element | null {
	switch (activity.kind) {
		case "external-user-invited":
			return activity.invitee ? (
				<>
					invited <b>{activity.invitee}</b> as a participant
				</>
			) : (
				<>invited a user as a participant</>
			);
		case "external-user-joined":
			return activity.duplicate_report_id ? (
				<>
					filed a duplicate
					(<a
						href={`https://hackerone.com/reports/${activity.duplicate_report_id}`}
						target="_blank"
						rel="noopener noreferrer"
						onClick={(e) => {
							e.preventDefault();
							openUrl(`https://hackerone.com/reports/${activity.duplicate_report_id}`);
						}}
					>#{activity.duplicate_report_id}</a>)
					and was invited to participate in this report
				</>
			) : (
				<>joined this report as a participant</>
			);
		case "changed-scope":
			return activity.old_scope && activity.new_scope ? (
				<>
					changed the scope from <b>{activity.old_scope}</b> to <b>{activity.new_scope}</b>
				</>
			) : (
				<>changed the scope</>
			);
		case "report-vulnerability-types-updated":
			return activity.new_weakness ? (
				<>
					added weakness <b>"{activity.new_weakness}"</b>
				</>
			) : (
				<>updated the vulnerability types</>
			);
		case "group-assigned-to-bug":
			return activity.group_name ? (
				<>
					assigned this report to <b>{activity.group_name}</b>
				</>
			) : (
				<>assigned this report to a group</>
			);
		case "report-organization-inboxes-updated":
			return <>updated the organization inboxes</>;
		default:
			return null;
	}
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
 *   - Anyone who isn't the original reporter is program-side.
 */
export function isProgramSide(activity: Activity, reporterId: string): boolean {
	if (activity.internal) return true;
	return activity.actor?.id !== reporterId;
}

export function renderActivity(activity: Activity, reporterId: string) {
	const isComment = activity.type === "comment";
	const message = isComment ? activity.message : (activity.message ?? "");
	const hasMessage = message.trim().length > 0;
	const messageAttachments = activity.type === "comment" ? activity.attachments : undefined;
	const newState = !isComment ? bugStateFromKind(activity.kind) : null;

	// Non-state-change events with no message body collapse to a one-line tick.
	if (activity.type === "event" && !newState && !hasMessage) {
		const description = describeEvent(activity);
		const tickClasses = ["event-tick", activity.internal ? "internal" : ""]
			.filter(Boolean)
			.join(" ");
		return (
			<div key={activity.id} class={tickClasses}>
				<span class="event-tick-text">
					{activity.internal && <span class="msg-internal-flag">INTERNAL</span>}
					{activity.actor && <Avatar user={activity.actor} />}
					{activity.actor && <b>{activity.actor.username}</b>}
					{activity.actor && " "}
					{description ?? <b>{humanizeKind(activity.kind)}</b>}
				</span>
				<span class="event-time">{formatRelativeTime(activity.created_at)}</span>
			</div>
		);
	}

	const author = activity.actor?.username ?? "system";
	const isReporter = activity.actor?.id === reporterId;
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
			{hasMessage && (
				<Markdown source={message} attachments={messageAttachments} class="msg-bubble" />
			)}
		</div>
	);
}
