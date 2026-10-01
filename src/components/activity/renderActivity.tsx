import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "preact";
import type { Activity, UserRef } from "../../state/store";
import { formatMoney } from "../../utils/money";
import { pillFor } from "../../utils/pill";
import { formatTitle } from "../../utils/title";
import { Avatar } from "../Avatar";
import { AttachmentGallery, Markdown, referencedAttachmentIds } from "../Markdown";
import { RelativeTime } from "../RelativeTime";
import { ReportLink } from "../ReportLink";
import { SeverityMeter } from "../SeverityMeter";

type EventActivity = Extract<Activity, { type: "event" }>;

/**
 * HackerOne's own staff (CSMs, managed triage) are added to a program's member
 * list, so the program-membership check alone mislabels them as program staff.
 * They use a reserved `h1_` username prefix, which is the only reliable signal —
 * `user_type` ("company") and `hackerone_triager` (false for CSMs) don't tell
 * them apart from genuine program staff.
 */
export function isHackerOneStaff(user: UserRef | null): boolean {
	return !!user && user.username.startsWith("h1_");
}

/**
 * Automation accounts (`auto-*`, created by HackerOne workflow automations) sit in the
 * program member list, so the membership check alone would label them program staff.
 */
export function isBot(user: UserRef | null): boolean {
	return user?.user_type === "automation";
}

export function humanizeKind(kind: string): string {
	return kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SEVERITY_RANK: Record<string, number> = {
	none: 1,
	low: 2,
	medium: 3,
	high: 4,
	critical: 5,
};

/**
 * Verb for a severity change when both endpoints are known: "upgraded" when the
 * new rating is higher, "downgraded" when lower, and "changed" as a fallback for
 * unrecognised ratings (where we can't order them).
 */
function severityChangeVerb(oldSeverity: string, newSeverity: string): string {
	const from = SEVERITY_RANK[oldSeverity.toLowerCase()] ?? 0;
	const to = SEVERITY_RANK[newSeverity.toLowerCase()] ?? 0;
	if (from && to && to > from) return "upgraded";
	if (from && to && to < from) return "downgraded";
	return "changed";
}

/**
 * Render a verb-phrase describing what happened in a non-comment event,
 * pulling in kind-specific fields (invitee, scope names, weakness, etc.).
 * Returns null for kinds we don't have a custom phrasing for, so callers
 * can fall back to a humanized kind label.
 *
 * `currentInboxNames` carries the report's current custom inbox name(s), but
 * only for the most recent inbox-update event — the H1 API doesn't expose the
 * inbox on the `report-organization-inboxes-updated` activity itself, so we can
 * only reliably name it on the event that produced the current inbox state.
 */
export function describeEvent(
	activity: EventActivity,
	currentInboxNames: string[] | null,
	currentCveIds: string[] | null,
	referenceUrl: string | null = null,
): JSX.Element | null {
	switch (activity.kind) {
		case "bounty-suggested":
		case "bounty-awarded":
			return activity.bounty_amount !== null ? (
				<>
					{activity.kind === "bounty-awarded" ? "awarded" : "suggested"}
					{activity.kind === "bounty-awarded" && activity.awarded_user ? (
						<>
							{" "}
							<b>{activity.awarded_user.username}</b>
						</>
					) : null}{" "}
					a bounty of <b>{formatMoney(activity.bounty_amount)}</b>
					{activity.bonus_amount ? (
						<>
							{" "}
							+ <b>{formatMoney(activity.bonus_amount)}</b> bonus
						</>
					) : null}
				</>
			) : null;
		case "bounty-cancelled":
			return <>cancelled the bounty</>;
		case "not-eligible-for-bounty":
			return <>marked this report as ineligible for a bounty</>;
		case "comments-closed":
			return <>locked this report</>;
		case "hacker-requested-mediation":
			return <>requested mediation</>;
		case "report-became-public":
		case "manually-disclosed":
			return <>disclosed this report</>;
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
					filed a duplicate (<ReportLink id={activity.duplicate_report_id} />) and was invited to
					participate in this report
				</>
			) : (
				<>joined this report as a participant</>
			);
		case "report-collaborator-invited":
			return activity.invitee ? (
				<>
					invited <b>{activity.invitee}</b> as a collaborator
				</>
			) : (
				<>invited a user as a collaborator</>
			);
		case "report-collaborator-joined":
			return <>joined this report as a collaborator</>;
		case "changed-scope":
			return activity.new_scope ? (
				<>
					changed the scope to <b>{activity.new_scope}</b>
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
		case "user-assigned-to-bug":
			if (!activity.assigned_user) {
				return <>assigned this report to a user</>;
			}
			return activity.actor && activity.actor.id === activity.assigned_user.id ? (
				<>claimed this report</>
			) : (
				<>
					assigned this report to <b>{activity.assigned_user.username}</b>
				</>
			);
		case "reference-id-added": {
			if (!activity.reference) {
				return <>added a reference id</>;
			}
			const reference = referenceUrl ? (
				<a
					href={referenceUrl}
					target="_blank"
					rel="noopener noreferrer"
					onClick={(e) => {
						e.preventDefault();
						openUrl(referenceUrl);
					}}
				>
					{activity.reference}
				</a>
			) : (
				<b>{activity.reference}</b>
			);
			return <>added reference id {reference}</>;
		}
		case "group-assigned-to-bug":
			return activity.group_name ? (
				<>
					assigned this report to <b>{activity.group_name}</b>
				</>
			) : (
				<>assigned this report to a group</>
			);
		case "report-title-updated":
			return activity.new_title ? (
				<>
					changed the title to <b>{formatTitle(activity.new_title)}</b>
				</>
			) : (
				<>changed the report title</>
			);
		case "cve-id-added":
			// The H1 `activity-cve-id-added` event fires for adding, replacing, and removing
			// a CVE ID alike and carries no attributes, so only the latest one can be named.
			if (currentCveIds === null) {
				return <>updated the CVE ID</>;
			}
			return currentCveIds.length > 0 ? (
				<>
					updated the CVE ID to <b>{currentCveIds.join(", ")}</b>
				</>
			) : (
				<>removed the CVE reference</>
			);
		case "report-organization-inboxes-updated":
			return currentInboxNames && currentInboxNames.length > 0 ? (
				<>
					updated the {currentInboxNames.length > 1 ? "inboxes" : "inbox"} to{" "}
					<b>{currentInboxNames.join(", ")}</b>
				</>
			) : (
				<>updated the organization inboxes</>
			);
		case "report-severity-updated":
			if (!activity.new_severity) {
				return activity.old_severity ? <>removed the severity</> : <>updated the severity</>;
			}
			return activity.old_severity ? (
				<>
					{severityChangeVerb(activity.old_severity, activity.new_severity)} severity from{" "}
					<SeverityMeter rating={activity.old_severity} showLabel /> to{" "}
					<SeverityMeter rating={activity.new_severity} showLabel />
				</>
			) : (
				<>
					changed severity to <SeverityMeter rating={activity.new_severity} showLabel />
				</>
			);
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
 * The action an event took, as shown beside the actor in a message header: a state change as
 * "changed status to <pill>", anything else as describeEvent's phrase, falling back to the
 * humanized kind. Shared by the detail pane's thread and the discussion feed.
 */
export function describeEventAction(
	event: EventActivity,
	currentInboxNames: string[] | null = null,
	currentCveIds: string[] | null = null,
	referenceUrl: string | null = null,
): JSX.Element {
	const newState = bugStateFromKind(event.kind);
	if (newState) {
		const pill = pillFor(newState);
		return (
			<>
				<span class="msg-event-action">changed status to</span>
				{event.original_report_id ? (
					<span class={`pill ${pill.className}`}>
						{pill.label} of <ReportLink id={event.original_report_id} />
					</span>
				) : (
					<span class={`pill ${pill.className}`}>{pill.label}</span>
				)}
			</>
		);
	}
	const description = describeEvent(event, currentInboxNames, currentCveIds, referenceUrl);
	return description ? (
		<span class="msg-event-action">{description}</span>
	) : (
		<span class="msg-event-kind">{humanizeKind(event.kind)}</span>
	);
}

/**
 * Decide whether an activity should be rendered on the program/team side
 * (right-aligned, "out") or the reporter side (left-aligned, "in").
 *
 *   - Internal activities are always program-side (the reporter never sees them).
 *   - Activities with no actor (system events) default to reporter-side.
 *   - The reporter is always on the reporter side, even if they are also program staff
 *     (e.g. a team member who filed a report against their own program) — otherwise the
 *     two sides of the conversation would collapse.
 *   - HackerOne staff and automation bots act for the program, so they are program-side.
 *   - Otherwise the actor's program-team membership decides it: program staff are
 *     program-side, everyone else (external participants, hackbot, etc.) is reporter-side.
 */
export function isProgramSide(
	activity: Activity,
	reporterId: string,
	teamMemberIds: Set<string>,
): boolean {
	if (activity.internal) return true;
	const actorId = activity.actor?.id;
	if (!actorId) return false;
	if (actorId === reporterId) return false;
	if (isHackerOneStaff(activity.actor) || isBot(activity.actor)) return true;
	return teamMemberIds.has(actorId);
}

export function renderActivity(
	activity: Activity,
	reporterId: string,
	teamMemberIds: Set<string>,
	programHandle: string | null,
	currentInboxNames: string[] | null = null,
	currentCveIds: string[] | null = null,
	// The report's current issue-tracker URL; the activity itself only carries the id.
	referenceUrl: string | null = null,
) {
	const isComment = activity.type === "comment";
	const message = isComment ? activity.message : (activity.message ?? "");
	const hasMessage = message.trim().length > 0;
	const messageAttachments = activity.type === "comment" ? activity.attachments : undefined;
	// Attachments not embedded in the body via {F<id>} are shown below the message.
	const referencedIds = referencedAttachmentIds(message);
	const extraAttachments = (messageAttachments ?? []).filter((a) => !referencedIds.has(a.id));
	const newState = !isComment ? bugStateFromKind(activity.kind) : null;
	const actorIsBot = isBot(activity.actor);
	const actorIsHackerOneStaff = isHackerOneStaff(activity.actor);
	const isStaff = !!activity.actor && teamMemberIds.has(activity.actor.id);
	const staffFlag = actorIsBot ? (
		<span class="msg-staff-flag bot">BOT</span>
	) : actorIsHackerOneStaff ? (
		<span class="msg-staff-flag hackerone">HACKERONE STAFF</span>
	) : isStaff && programHandle ? (
		<span class="msg-staff-flag">{programHandle.toUpperCase()} STAFF</span>
	) : null;

	// Non-state-change events with no message body collapse to a one-line tick.
	if (activity.type === "event" && !newState && !hasMessage) {
		const description = describeEvent(activity, currentInboxNames, currentCveIds, referenceUrl);
		const tickClasses = ["event-tick", activity.internal ? "internal" : ""]
			.filter(Boolean)
			.join(" ");
		return (
			<div key={activity.id} data-activity-id={activity.id} class={tickClasses}>
				<span class="event-tick-text">
					{activity.actor && (
						<>
							<Avatar user={activity.actor} />
							<b>{activity.actor.username}</b>
							{staffFlag}{" "}
						</>
					)}
					{description ?? <b>{humanizeKind(activity.kind)}</b>}
				</span>
				<span class="event-time">
					{activity.internal && (
						<span class="icon-padlock" role="img" title="Internal" aria-label="Internal" />
					)}
					<RelativeTime iso={activity.created_at} />
				</span>
			</div>
		);
	}

	const author = activity.actor?.username ?? "system";
	const isReporter = activity.actor?.id === reporterId;
	const side = isProgramSide(activity, reporterId, teamMemberIds) ? "out" : "in";
	const classes = ["msg", side, activity.internal ? "internal" : ""].filter(Boolean).join(" ");
	const event = activity.type === "event" ? activity : null;

	return (
		<div key={activity.id} data-activity-id={activity.id} class={classes}>
			<div class="msg-meta">
				<Avatar user={activity.actor} />
				<span class="msg-author">{author}</span>
				{staffFlag}
				{isReporter && <span class="msg-reporter-flag">REPORTER</span>}
				{event ? describeEventAction(event, currentInboxNames, currentCveIds, referenceUrl) : null}
				<span class="msg-time">
					{activity.internal && (
						<span class="icon-padlock" role="img" title="Internal" aria-label="Internal" />
					)}
					<RelativeTime iso={activity.created_at} />
				</span>
			</div>
			{(hasMessage || extraAttachments.length > 0) && (
				<div class="msg-bubble">
					{hasMessage && <Markdown source={message} attachments={messageAttachments} />}
					<AttachmentGallery attachments={extraAttachments} class="msg-attachments" />
				</div>
			)}
		</div>
	);
}
