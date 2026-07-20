import { pillFor } from "../utils/pill";
import { DEFAULT_SEVERITY_KEYS, DEFAULT_STATE_KEYS } from "./filters";

export type AppError =
	| { kind: "unauthorized"; message: string }
	| { kind: "forbidden"; message: string }
	| { kind: "not_found"; message: string }
	| { kind: "rate_limited"; message: string }
	| { kind: "network"; message: string }
	| { kind: "keychain"; message: string }
	| { kind: "other"; message: string };

export type AsyncState<T> =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; data: T }
	| { status: "error"; error: AppError };

// Non-secret user preferences, persisted on the Rust side (see settings.rs). `triage_working_dir`
// is null until the user picks a directory — there's no default.
export type Settings = { triage_working_dir: string | null };

export type Organization = { id: string; handle: string };
export type Program = { id: string; handle: string };
export type TeamMember = { id: string; username: string };
export type Asset = {
	id: string;
	identifier: string;
	asset_type: string | null;
	in_scope: boolean;
};
export type ReportSummary = {
	id: string;
	title: string;
	// Full report description, carried from the /reports list so the detail pane can show it
	// immediately on selection. Large field — it inflates list responses noticeably.
	vulnerability_information: string;
	state: string;
	severity_rating: string | null;
	created_at: string;
	last_activity_at: string | null;
	issue_tracker_reference_id: string | null;
	issue_tracker_reference_url: string | null;
	asset: AssetRef | null;
	weakness: WeaknessRef | null;
	reporter: UserRef;
	assignee: AssigneeRef | null;
	inboxes: InboxRef[];
	bounty: BountyTotal | null;
};

export type UserRef = {
	id: string;
	username: string;
	name: string | null;
	profile_picture_url: string | null;
};
export type AssigneeRef = {
	type: "user" | "group" | string;
	id: string;
	username: string | null;
	name: string | null;
	profile_picture_url: string | null;
};

// A selectable assignee in the sidebar filter. `value` is the token the local query matches
// against (the `assignee_token` generated column): the username for a user, the name for a group.
// Options are derived from the assignees seen on loaded reports and accumulated across sessions,
// since groups can't be enumerated via the API.
export type AssigneeOption = {
	type: "user" | "group";
	value: string;
	label: string;
	profile_picture_url: string | null;
};
export type WeaknessRef = { id: string; name: string; external_id: string | null };
export type AssetRef = { id: string; asset_identifier: string; asset_type: string | null };
export type InboxRef = { id: string; name: string; kind: string | null };
// Total awarded bounty (base + bonus) summed across all awards on a report.
export type BountyTotal = { amount: number; currency: string | null };

export type Attachment = {
	id: string;
	file_name: string;
	content_type: string | null;
	file_size: number | null;
	expiring_url: string;
};

export type Activity =
	| {
			type: "comment";
			id: string;
			created_at: string;
			message: string;
			internal: boolean;
			actor: UserRef | null;
			attachments: Attachment[];
	  }
	| {
			type: "event";
			id: string;
			created_at: string;
			kind: string;
			message: string | null;
			internal: boolean;
			actor: UserRef | null;
			invitee: string | null;
			duplicate_report_id: string | null;
			original_report_id: string | null;
			old_scope: string | null;
			new_scope: string | null;
			new_weakness: string | null;
			group_name: string | null;
			old_severity: string | null;
			new_severity: string | null;
			old_title: string | null;
			new_title: string | null;
			bounty_amount: number | null;
			bonus_amount: number | null;
			assigned_user: UserRef | null;
			reference: string | null;
	  };

export type ReportDetail = {
	id: string;
	title: string;
	state: string;
	main_state: string;
	severity_rating: string | null;
	created_at: string;
	vulnerability_information: string;
	issue_tracker_reference_id: string | null;
	issue_tracker_reference_url: string | null;
	reporter: UserRef;
	weakness: WeaknessRef | null;
	asset: AssetRef | null;
	inboxes: InboxRef[];
	activities: Activity[];
	attachments: Attachment[];
};

export type DetailToast = {
	id: string;
	reportId: string;
	message: string;
	// When set, clicking the toast should scroll the matching activity element into view.
	// Only populated for toasts describing new activities (single-item or summary).
	activityId?: string;
	// The activity this toast describes, carried so the view can render the same rich
	// phrasing as the activity log (via describeEvent) instead of the plain `message`.
	// Only set for single-activity toasts — summary/detail-change toasts leave it unset.
	activity?: Activity;
};

export type DetailPlacement = "right" | "bottom";

export type PanelKey = "detailRight" | "detailBottom";
export type PanelSizes = Record<PanelKey, number>;
export type PanelBounds = { min: number; max: number };

export const PANEL_BOUNDS: Record<PanelKey, PanelBounds> = {
	detailRight: { min: 280, max: 2400 },
	detailBottom: { min: 140, max: 1600 },
};

const SIDEBAR_WIDTH = 220;
const TOPBAR_HEIGHT = 46;
const RESIZER_THICKNESS = 6;
const MAX_FRACTION = 0.8;

export type Viewport = { width: number; height: number };

function readViewport(): Viewport {
	return {
		width: typeof window !== "undefined" ? window.innerWidth : 1200,
		height: typeof window !== "undefined" ? window.innerHeight : 800,
	};
}

export function effectiveMaxFor(panel: PanelKey, vp: Viewport): number {
	const base = PANEL_BOUNDS[panel];
	const available =
		panel === "detailRight"
			? vp.width - SIDEBAR_WIDTH - RESIZER_THICKNESS
			: vp.height - TOPBAR_HEIGHT - RESIZER_THICKNESS;
	return Math.max(base.min, Math.min(base.max, Math.floor(available * MAX_FRACTION)));
}

export function clampPanelForViewport(panel: PanelKey, size: number, vp: Viewport): number {
	return clampPanelSize(size, { min: PANEL_BOUNDS[panel].min, max: effectiveMaxFor(panel, vp) });
}

function defaultPanelSizes(vp: Viewport): PanelSizes {
	return {
		detailRight: clampPanelForViewport(
			"detailRight",
			(vp.width - SIDEBAR_WIDTH - RESIZER_THICKNESS) / 2,
			vp,
		),
		detailBottom: clampPanelForViewport(
			"detailBottom",
			(vp.height - TOPBAR_HEIGHT - RESIZER_THICKNESS) / 2,
			vp,
		),
	};
}

export function clampPanelSize(value: number, bounds: PanelBounds): number {
	if (!Number.isFinite(value)) return bounds.min;
	return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

// Triage events come straight from `claude --output-format stream-json` — JSON objects
// with a `type` field (`system`, `assistant`, `user`, `result`, or our own `raw`).
// We keep the original shape so the renderer can decide how to display each kind.
// biome-ignore lint/suspicious/noExplicitAny: stream-json events vary in shape per `type`
export type TriageEvent = { type: string; [key: string]: any };

export type TriageValidity = "valid" | "partially-valid" | "invalid" | "indeterminate" | "none";

// What we store per report — the markdown summary plus an optional structured verdict.
// `validity` is null for legacy entries written before claude was asked for JSON output,
// or for runs where claude didn't emit a parseable verdict. `new_files` lists absolute paths
// to files claude wrote during the run (may be empty), each individually deletable from the UI.
export type TriageRecord = {
	summary: string;
	validity: TriageValidity | null;
	new_files: string[];
};

export type TriageState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "running"; events: TriageEvent[]; saved: TriageRecord | null }
	| { status: "ready"; result: TriageRecord; events: TriageEvent[] }
	| { status: "error"; error: AppError; events: TriageEvent[]; saved: TriageRecord | null };

// Progress of the background sync that mirrors HackerOne into the local SQLite DB (see sync.rs).
// Driven by the `sync:status` Tauri event. `phase` is "initial" for the first open-reports page,
// "summaries" while backfilling the report list, "detail" while backfilling per-report detail,
// and "idle" when nothing is running.
export type SyncStatus = {
	phase: "idle" | "initial" | "summaries" | "detail";
	done: number;
	total: number;
	running: boolean;
};

// One report's text sent to Claude for duplicate comparison. Built from the loaded report
// summaries, so no extra fetch is needed.
export type DuplicateInput = { id: string; title: string; body: string };

// Claude's brief markdown verdict on whether the selected reports are duplicates.
export type DuplicateResult = { summary: string };

// The duplicate check is keyed to the current bulk selection, so there's a single instance of
// this state rather than a per-report map. Events stream in while running, same as triage.
export type DuplicateCheckState =
	| { status: "idle" }
	| { status: "running"; events: TriageEvent[] }
	| { status: "ready"; result: DuplicateResult; events: TriageEvent[] }
	| { status: "error"; error: AppError; events: TriageEvent[] };

export type AppState = {
	credentials: "unknown" | "missing" | "present";
	username: string | null;
	// Triage working directory the Rust side spawns `claude` in. Null until configured.
	triageWorkingDir: string | null;
	bootstrap: AsyncState<{ orgs: Organization[] }>;
	programsByOrg: Record<string, AsyncState<Program[]>>;
	assetsByOrg: Record<string, AsyncState<Asset[]>>;
	teamMembersByProgram: Record<string, AsyncState<TeamMember[]>>;
	// Assignee filter options accumulated per program handle from the assignees seen on loaded
	// reports. Persisted to localStorage so the list stays useful across launches — groups in
	// particular can't be enumerated via the API, so they're only ever learned from report data.
	assigneeOptionsByProgram: Record<string, AssigneeOption[]>;
	filters: {
		orgId?: string;
		programHandle?: string;
		states: string[];
		severities: string[];
		assets: string[];
		// Selected assignee filter tokens (usernames and group names) — see AssigneeOption.value.
		assignees: string[];
		search: string;
	};
	// The report list, queried from the local SQLite mirror. Every query returns all matches —
	// there is no pagination.
	reports: AsyncState<{ items: ReportSummary[] }>;
	// Bumped each time the report list is replaced by a fresh query (filter change / manual
	// refresh). Consumers watch this to react to "fresh list" events — e.g. scrolling to top.
	reportsReplaceCount: number;
	// Latest background-sync progress, for the Topbar indicator.
	sync: SyncStatus;
	// Total reports mirrored locally for the current program (null until first counted). Shown in
	// the Topbar when no sync is actively running.
	syncedReportCount: number | null;
	selectedReportId: string | null;
	// Multi-selection of reports (via the inbox checkboxes). Two or more selected enables the
	// duplicate check; the same set also drives the bulk report download.
	selectedReportIds: Set<string>;
	// Result of the "are these reports duplicates" check over the current selection. Reset to
	// idle whenever the selection changes, since a verdict only applies to the set it ran on.
	duplicateCheck: DuplicateCheckState;
	detailActiveTab: "report" | "duplicates";
	detail: Record<string, AsyncState<ReportDetail>>;
	// Reports whose detail pane is currently showing summary-derived placeholder data while the
	// full get_report fetch is in flight. Used to render "loading" affordances for the fields the
	// list summary doesn't carry (description, discussion). Cleared once the fetch resolves.
	detailPending: Record<string, true>;
	triage: Record<string, TriageState>;
	// Lightweight per-report triage status surfaced in the inbox row (`null` means a triage
	// was saved but no validity verdict was recorded — e.g. legacy entries or parse failures).
	// Missing keys = no triage saved.
	triageValidityByReport: Record<string, TriageValidity | null>;
	// Transient notifications surfaced inside the detail pane after a background refresh
	// turns up new activity or detail changes. Tied to the currently selected report only —
	// cleared on REPORT_SELECTED so they don't bleed across navigations.
	detailToasts: DetailToast[];
	detailPlacement: DetailPlacement;
	panelSizes: PanelSizes;
	viewport: Viewport;
};

export type Action =
	| { type: "CREDENTIALS_KNOWN"; present: boolean; username: string | null }
	| { type: "CREDENTIALS_SAVED"; username: string }
	| { type: "CREDENTIALS_CLEARED" }
	| { type: "SETTINGS_LOADED"; settings: Settings }
	| { type: "TRIAGE_WORKING_DIR_SET"; dir: string | null }
	| { type: "BOOTSTRAP_REQUESTED" }
	| { type: "BOOTSTRAP_SUCCEEDED"; orgs: Organization[] }
	| { type: "BOOTSTRAP_FAILED"; error: AppError }
	| { type: "PROGRAMS_REQUESTED"; orgId: string }
	| { type: "PROGRAMS_SUCCEEDED"; orgId: string; programs: Program[] }
	| { type: "PROGRAMS_FAILED"; orgId: string; error: AppError }
	| { type: "ASSETS_REQUESTED"; orgId: string }
	| { type: "ASSETS_SUCCEEDED"; orgId: string; assets: Asset[] }
	| { type: "ASSETS_FAILED"; orgId: string; error: AppError }
	| { type: "TEAM_MEMBERS_REQUESTED"; programHandle: string }
	| { type: "TEAM_MEMBERS_SUCCEEDED"; programHandle: string; members: TeamMember[] }
	| { type: "TEAM_MEMBERS_FAILED"; programHandle: string; error: AppError }
	| { type: "ORG_SELECTED"; orgId: string }
	| { type: "PROGRAM_SELECTED"; handle: string }
	| { type: "STATES_SET"; states: string[] }
	| { type: "SEVERITIES_SET"; severities: string[] }
	| { type: "ASSETS_SET"; assets: string[] }
	| { type: "ASSIGNEES_SET"; assignees: string[] }
	| { type: "SEARCH_SET"; search: string }
	| { type: "REPORTS_REQUESTED" }
	// `replace` is true for a user-initiated query (filter change / manual refresh / first load)
	// — it scrolls to top and may re-pick the selection. It's false for a background re-query
	// driven by the sync engine, which leaves scroll position and selection untouched.
	| { type: "REPORTS_SUCCEEDED"; items: ReportSummary[]; replace: boolean }
	| { type: "REPORTS_FAILED"; error: AppError }
	| { type: "SYNC_STATUS"; status: SyncStatus }
	| { type: "SYNCED_COUNT_SET"; count: number }
	| { type: "REPORT_SELECTED"; reportId: string | null }
	| { type: "SELECTION_TOGGLED"; reportId: string }
	| { type: "SELECTION_SET"; reportIds: string[]; checked: boolean }
	| { type: "SELECTION_CLEARED" }
	| { type: "DETAIL_TAB_SET"; tab: "report" | "duplicates" }
	| { type: "DUP_CHECK_STARTED" }
	| { type: "DUP_CHECK_EVENT"; event: TriageEvent }
	| { type: "DUP_CHECK_SUCCEEDED"; result: DuplicateResult }
	| { type: "DUP_CHECK_FAILED"; error: AppError }
	| { type: "TRIAGE_LOAD_REQUESTED"; reportId: string }
	| { type: "TRIAGE_LOAD_SUCCEEDED"; reportId: string; result: TriageRecord | null }
	| { type: "TRIAGE_RUN_STARTED"; reportId: string }
	| { type: "TRIAGE_EVENT"; reportId: string; event: TriageEvent }
	| { type: "TRIAGE_RUN_SUCCEEDED"; reportId: string; result: TriageRecord }
	| { type: "TRIAGE_RUN_FAILED"; reportId: string; error: AppError }
	// A triage new-file was deleted from disk; `remaining` is the pruned list to store.
	| { type: "TRIAGE_FILE_DELETED"; reportId: string; remaining: string[] }
	| {
			type: "TRIAGE_VALIDITY_LOADED";
			entries: { id: string; validity: TriageValidity | null }[];
	  }
	// Populate the detail pane immediately from the list summary while get_report is in flight.
	| { type: "DETAIL_SEEDED"; reportId: string }
	| { type: "DETAIL_SUCCEEDED"; reportId: string; detail: ReportDetail }
	| { type: "DETAIL_FAILED"; reportId: string; error: AppError }
	| { type: "DETAIL_REFRESHED"; reportId: string; detail: ReportDetail }
	| { type: "DETAIL_TOAST_DISMISSED"; toastId: string }
	| { type: "DETAIL_PLACEMENT_SET"; placement: DetailPlacement }
	| { type: "PANEL_SIZE_SET"; panel: PanelKey; size: number }
	| { type: "VIEWPORT_RESIZED"; width: number; height: number };

function loadDetailPlacement(): DetailPlacement {
	try {
		const stored = localStorage.getItem("macaroni.detailPlacement");
		if (stored === "bottom" || stored === "right") return stored;
	} catch {}
	return "right";
}

function loadPanelSizes(vp: Viewport): PanelSizes {
	const out: PanelSizes = defaultPanelSizes(vp);
	try {
		const raw = localStorage.getItem("macaroni.panelSizes");
		if (!raw) return out;
		const parsed = JSON.parse(raw) as Partial<Record<PanelKey, unknown>>;
		for (const key of Object.keys(PANEL_BOUNDS) as PanelKey[]) {
			const v = parsed[key];
			if (typeof v === "number") {
				out[key] = clampPanelForViewport(key, v, vp);
			}
		}
	} catch {}
	return out;
}

function loadAssigneeOptions(): Record<string, AssigneeOption[]> {
	try {
		const raw = localStorage.getItem("macaroni.assigneeOptions");
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, AssigneeOption[]>;
		}
	} catch {}
	return {};
}

export const initialState: AppState = {
	credentials: "unknown",
	username: null,
	triageWorkingDir: null,
	bootstrap: { status: "idle" },
	programsByOrg: {},
	assetsByOrg: {},
	teamMembersByProgram: {},
	assigneeOptionsByProgram: loadAssigneeOptions(),
	filters: {
		states: [...DEFAULT_STATE_KEYS],
		severities: [...DEFAULT_SEVERITY_KEYS],
		assets: [],
		assignees: [],
		search: "",
	},
	reports: { status: "idle" },
	reportsReplaceCount: 0,
	sync: { phase: "idle", done: 0, total: 0, running: false },
	syncedReportCount: null,
	selectedReportId: null,
	selectedReportIds: new Set(),
	duplicateCheck: { status: "idle" },
	detailActiveTab: "report",
	detail: {},
	detailPending: {},
	triage: {},
	triageValidityByReport: {},
	detailToasts: [],
	detailPlacement: loadDetailPlacement(),
	panelSizes: loadPanelSizes(readViewport()),
	viewport: readViewport(),
};

export function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "CREDENTIALS_KNOWN":
			return {
				...state,
				credentials: action.present ? "present" : "missing",
				username: action.present ? action.username : null,
			};
		case "CREDENTIALS_SAVED":
			return { ...state, credentials: "present", username: action.username };
		case "CREDENTIALS_CLEARED":
			return {
				...initialState,
				credentials: "missing",
				// The working directory is a machine-local preference, not tied to the account —
				// keep it across a logout the same way panel layout survives.
				triageWorkingDir: state.triageWorkingDir,
				detailPlacement: state.detailPlacement,
				panelSizes: state.panelSizes,
				viewport: state.viewport,
			};
		case "SETTINGS_LOADED":
			return { ...state, triageWorkingDir: action.settings.triage_working_dir };
		case "TRIAGE_WORKING_DIR_SET":
			return { ...state, triageWorkingDir: action.dir };
		case "BOOTSTRAP_REQUESTED":
			return { ...state, bootstrap: { status: "loading" } };
		case "BOOTSTRAP_SUCCEEDED":
			return {
				...state,
				bootstrap: { status: "ready", data: { orgs: action.orgs } },
				filters: state.filters.orgId
					? state.filters
					: { ...state.filters, orgId: action.orgs[0]?.id },
			};
		case "BOOTSTRAP_FAILED":
			return { ...state, bootstrap: { status: "error", error: action.error } };
		case "PROGRAMS_REQUESTED":
			return {
				...state,
				programsByOrg: {
					...state.programsByOrg,
					[action.orgId]: { status: "loading" },
				},
			};
		case "PROGRAMS_SUCCEEDED": {
			const autoSelect = !state.filters.programHandle && action.programs.length > 0;
			return {
				...state,
				programsByOrg: {
					...state.programsByOrg,
					[action.orgId]: { status: "ready", data: action.programs },
				},
				filters: autoSelect
					? { ...state.filters, programHandle: action.programs[0].handle }
					: state.filters,
			};
		}
		case "PROGRAMS_FAILED":
			return {
				...state,
				programsByOrg: {
					...state.programsByOrg,
					[action.orgId]: { status: "error", error: action.error },
				},
			};
		case "ASSETS_REQUESTED":
			return {
				...state,
				assetsByOrg: {
					...state.assetsByOrg,
					[action.orgId]: { status: "loading" },
				},
			};
		case "ASSETS_SUCCEEDED":
			return {
				...state,
				assetsByOrg: {
					...state.assetsByOrg,
					[action.orgId]: { status: "ready", data: action.assets },
				},
			};
		case "ASSETS_FAILED":
			return {
				...state,
				assetsByOrg: {
					...state.assetsByOrg,
					[action.orgId]: { status: "error", error: action.error },
				},
			};
		case "TEAM_MEMBERS_REQUESTED":
			return {
				...state,
				teamMembersByProgram: {
					...state.teamMembersByProgram,
					[action.programHandle]: { status: "loading" },
				},
			};
		case "TEAM_MEMBERS_SUCCEEDED":
			return {
				...state,
				teamMembersByProgram: {
					...state.teamMembersByProgram,
					[action.programHandle]: { status: "ready", data: action.members },
				},
			};
		case "TEAM_MEMBERS_FAILED":
			return {
				...state,
				teamMembersByProgram: {
					...state.teamMembersByProgram,
					[action.programHandle]: { status: "error", error: action.error },
				},
			};
		case "ORG_SELECTED":
			return {
				...state,
				filters: {
					orgId: action.orgId,
					programHandle: undefined,
					states: state.filters.states,
					severities: state.filters.severities,
					assets: [],
					assignees: [],
					search: state.filters.search,
				},
				reports: { status: "idle" },
				selectedReportId: null,
				selectedReportIds: new Set(),
			};
		case "PROGRAM_SELECTED":
			return {
				...state,
				// Assignee tokens (usernames / group names) are program-scoped, so drop the
				// selection when switching programs. The accumulated options stay (keyed by handle).
				filters: { ...state.filters, programHandle: action.handle, assignees: [] },
				reports: { status: "idle" },
				selectedReportId: null,
				selectedReportIds: new Set(),
			};
		case "STATES_SET":
			return {
				...state,
				filters: { ...state.filters, states: action.states },
			};
		case "SEVERITIES_SET":
			return {
				...state,
				filters: { ...state.filters, severities: action.severities },
			};
		case "ASSETS_SET":
			return {
				...state,
				filters: { ...state.filters, assets: action.assets },
			};
		case "ASSIGNEES_SET":
			return {
				...state,
				filters: { ...state.filters, assignees: action.assignees },
			};
		case "SEARCH_SET":
			return {
				...state,
				filters: { ...state.filters, search: action.search },
			};
		case "REPORTS_REQUESTED":
			return {
				...state,
				reports: state.reports.status === "ready" ? state.reports : { status: "loading" },
			};
		case "REPORTS_SUCCEEDED": {
			const items = action.items;
			const stillPresent =
				state.selectedReportId !== null && items.some((r) => r.id === state.selectedReportId);
			// Auto-select the first row when nothing valid is selected so the detail pane populates
			// without a manual click. On a background refresh we only do this if there's genuinely
			// no selection yet — we never yank the user off a report they're reading.
			const nextSelected = stillPresent
				? state.selectedReportId
				: action.replace || state.selectedReportId === null
					? (items[0]?.id ?? null)
					: state.selectedReportId;
			return {
				...state,
				reportsReplaceCount: action.replace
					? state.reportsReplaceCount + 1
					: state.reportsReplaceCount,
				selectedReportId: nextSelected,
				reports: { status: "ready", data: { items } },
				assigneeOptionsByProgram: accumulateAssigneeOptions(
					state.assigneeOptionsByProgram,
					state.filters.programHandle,
					items,
				),
			};
		}
		case "REPORTS_FAILED":
			return {
				...state,
				reports: { status: "error", error: action.error },
			};
		case "SYNC_STATUS":
			return { ...state, sync: action.status };
		case "SYNCED_COUNT_SET":
			return { ...state, syncedReportCount: action.count };
		case "REPORT_SELECTED":
			return {
				...state,
				selectedReportId: action.reportId,
				// Clicking a report opens it in the Report tab, even while bulk-selecting.
				detailActiveTab: action.reportId ? "report" : state.detailActiveTab,
				detailToasts: [],
			};
		case "SELECTION_TOGGLED": {
			const next = new Set(state.selectedReportIds);
			if (next.has(action.reportId)) next.delete(action.reportId);
			else next.add(action.reportId);
			return { ...state, selectedReportIds: next, duplicateCheck: { status: "idle" } };
		}
		case "SELECTION_SET": {
			const next = new Set(state.selectedReportIds);
			for (const id of action.reportIds) {
				if (action.checked) next.add(id);
				else next.delete(id);
			}
			return { ...state, selectedReportIds: next, duplicateCheck: { status: "idle" } };
		}
		case "SELECTION_CLEARED":
			return { ...state, selectedReportIds: new Set(), duplicateCheck: { status: "idle" } };
		case "DETAIL_TAB_SET":
			return { ...state, detailActiveTab: action.tab };
		case "DUP_CHECK_STARTED":
			return { ...state, duplicateCheck: { status: "running", events: [] } };
		case "DUP_CHECK_EVENT": {
			const prev = state.duplicateCheck;
			if (prev.status !== "running") return state;
			return { ...state, duplicateCheck: { ...prev, events: [...prev.events, action.event] } };
		}
		case "DUP_CHECK_SUCCEEDED": {
			const prev = state.duplicateCheck;
			// Ignore a result that lands after the selection changed (which resets us to idle) —
			// the verdict only applies to the set the run started on.
			if (prev.status !== "running") return state;
			return {
				...state,
				duplicateCheck: { status: "ready", result: action.result, events: prev.events },
			};
		}
		case "DUP_CHECK_FAILED": {
			const prev = state.duplicateCheck;
			if (prev.status !== "running") return state;
			return {
				...state,
				duplicateCheck: { status: "error", error: action.error, events: prev.events },
			};
		}
		case "TRIAGE_LOAD_REQUESTED":
			return {
				...state,
				triage: { ...state.triage, [action.reportId]: { status: "loading" } },
			};
		case "TRIAGE_LOAD_SUCCEEDED":
			return {
				...state,
				triage: {
					...state.triage,
					[action.reportId]:
						action.result !== null
							? { status: "ready", result: action.result, events: [] }
							: { status: "idle" },
				},
				triageValidityByReport:
					action.result !== null
						? {
								...state.triageValidityByReport,
								[action.reportId]: action.result.validity,
							}
						: state.triageValidityByReport,
			};
		case "TRIAGE_RUN_STARTED": {
			const prev = state.triage[action.reportId];
			const saved: TriageRecord | null =
				prev?.status === "ready"
					? prev.result
					: prev?.status === "running" || prev?.status === "error"
						? prev.saved
						: null;
			return {
				...state,
				triage: {
					...state.triage,
					[action.reportId]: { status: "running", events: [], saved },
				},
			};
		}
		case "TRIAGE_EVENT": {
			const prev = state.triage[action.reportId];
			if (!prev || prev.status !== "running") return state;
			return {
				...state,
				triage: {
					...state.triage,
					[action.reportId]: { ...prev, events: [...prev.events, action.event] },
				},
			};
		}
		case "TRIAGE_RUN_SUCCEEDED": {
			const prev = state.triage[action.reportId];
			const events = prev && "events" in prev ? prev.events : [];
			return {
				...state,
				triage: {
					...state.triage,
					[action.reportId]: { status: "ready", result: action.result, events },
				},
				triageValidityByReport: {
					...state.triageValidityByReport,
					[action.reportId]: action.result.validity,
				},
			};
		}
		case "TRIAGE_RUN_FAILED": {
			const prev = state.triage[action.reportId];
			const events = prev && "events" in prev ? prev.events : [];
			const saved = prev?.status === "running" || prev?.status === "error" ? prev.saved : null;
			return {
				...state,
				triage: {
					...state.triage,
					[action.reportId]: { status: "error", error: action.error, events, saved },
				},
			};
		}
		case "TRIAGE_FILE_DELETED": {
			const prev = state.triage[action.reportId];
			if (!prev) return state;
			// The record holding new_files lives in different slots per status. Update whichever
			// one is present; leave idle/loading untouched (no record to prune).
			let updated: TriageState | null = null;
			if (prev.status === "ready") {
				updated = { ...prev, result: { ...prev.result, new_files: action.remaining } };
			} else if (prev.status === "running" || prev.status === "error") {
				updated = prev.saved
					? { ...prev, saved: { ...prev.saved, new_files: action.remaining } }
					: prev;
			}
			if (!updated) return state;
			return {
				...state,
				triage: { ...state.triage, [action.reportId]: updated },
			};
		}
		case "TRIAGE_VALIDITY_LOADED": {
			const next: Record<string, TriageValidity | null> = { ...state.triageValidityByReport };
			for (const e of action.entries) next[e.id] = e.validity;
			return { ...state, triageValidityByReport: next };
		}
		case "DETAIL_SEEDED": {
			const existing = state.detail[action.reportId];
			// Don't clobber a report we've already fully fetched (e.g. reselecting one we have).
			if (existing && existing.status === "ready") return state;
			// Populate the pane immediately from the list summary if we have one, so the user
			// sees the report's known fields without waiting for get_report. Fall back to a bare
			// loading state if there's no summary to seed from (e.g. deep-linked selection).
			const summary =
				state.reports.status === "ready"
					? state.reports.data.items.find((r) => r.id === action.reportId)
					: undefined;
			if (!summary) {
				return {
					...state,
					detail: { ...state.detail, [action.reportId]: { status: "loading" } },
				};
			}
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "ready", data: summaryToPartialDetail(summary) },
				},
				detailPending: { ...state.detailPending, [action.reportId]: true },
			};
		}
		case "DETAIL_SUCCEEDED": {
			// The inbox row was loaded from /reports earlier — it may be stale by the time
			// the user clicks in. Reconcile it against the freshly fetched detail so the
			// summary fields (state, severity, title, asset, etc.) match what's in the pane.
			const detailPending = { ...state.detailPending };
			delete detailPending[action.reportId];
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "ready", data: action.detail },
				},
				detailPending,
				reports: applyDetailToReports(state.reports, action.reportId, action.detail),
			};
		}
		case "DETAIL_FAILED": {
			const detailPending = { ...state.detailPending };
			delete detailPending[action.reportId];
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "error", error: action.error },
				},
				detailPending,
			};
		}
		case "DETAIL_REFRESHED": {
			const existing = state.detail[action.reportId];
			const nextDetail: AppState["detail"] = {
				...state.detail,
				[action.reportId]: { status: "ready", data: action.detail },
			};
			const nextReports = applyDetailToReports(state.reports, action.reportId, action.detail);
			const detailPending = { ...state.detailPending };
			delete detailPending[action.reportId];
			// First time the full data lands — either the refresh raced ahead of the initial
			// fetch, or it's replacing the summary-derived seed. Either way there's no prior
			// *fetched* snapshot to diff against, so install it with no toasts. (`pending` marks
			// a seed: a "ready" entry that's only placeholder data, so don't diff against it.)
			if (!existing || existing.status !== "ready" || state.detailPending[action.reportId]) {
				return { ...state, detail: nextDetail, detailPending, reports: nextReports };
			}
			// Only surface toasts when the refresh is for the currently selected report —
			// otherwise the user would see notifications inside a pane that isn't visible.
			if (state.selectedReportId !== action.reportId) {
				return { ...state, detail: nextDetail, detailPending, reports: nextReports };
			}
			const newToasts = diffReportDetail(existing.data, action.detail, action.reportId);
			return {
				...state,
				detail: nextDetail,
				detailPending,
				reports: nextReports,
				detailToasts: [...state.detailToasts, ...newToasts],
			};
		}
		case "DETAIL_TOAST_DISMISSED":
			return {
				...state,
				detailToasts: state.detailToasts.filter((t) => t.id !== action.toastId),
			};
		case "DETAIL_PLACEMENT_SET":
			return { ...state, detailPlacement: action.placement };
		case "PANEL_SIZE_SET":
			return {
				...state,
				panelSizes: {
					...state.panelSizes,
					[action.panel]: clampPanelForViewport(action.panel, action.size, state.viewport),
				},
			};
		case "VIEWPORT_RESIZED": {
			const vp: Viewport = { width: action.width, height: action.height };
			const next: PanelSizes = { ...state.panelSizes };
			for (const key of Object.keys(state.panelSizes) as PanelKey[]) {
				next[key] = clampPanelForViewport(key, state.panelSizes[key], vp);
			}
			return { ...state, viewport: vp, panelSizes: next };
		}
	}
}

// Compare two inbox lists by id and name (order-sensitive — the API returns them in a stable
// order). Used to decide whether a refresh actually moved the report between inboxes.
function sameInboxes(a: InboxRef[], b: InboxRef[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((x, i) => x.id === b[i].id && x.name === b[i].name);
}

// Reconcile the inbox-list row for `reportId` against a freshly fetched detail. Only the
// fields that overlap between ReportSummary and ReportDetail are touched; everything else
// (assignee, last_activity_at) is left as-is since the detail endpoint doesn't carry it.
// Returns the same reports state reference when nothing actually changed so consumers can
// skip re-renders via reference identity.
// Build a placeholder ReportDetail from the list summary so the detail pane can render
// immediately on selection, before get_report returns. Fields the summary doesn't carry
// (activities, attachments) are left empty and filled in once the real fetch lands — the
// `detailPending` flag tells the view which of those are still loading
// rather than genuinely absent. The description (vulnerability_information) and weakness ARE
// carried by the summary, so they show right away; only the description's inline attachment
// images wait for the fetch. `main_state` has no summary equivalent; reuse `state`, which
// drives the same pill.
function summaryToPartialDetail(s: ReportSummary): ReportDetail {
	return {
		id: s.id,
		title: s.title,
		state: s.state,
		main_state: s.state,
		severity_rating: s.severity_rating,
		created_at: s.created_at,
		vulnerability_information: s.vulnerability_information,
		issue_tracker_reference_id: s.issue_tracker_reference_id,
		issue_tracker_reference_url: s.issue_tracker_reference_url,
		reporter: s.reporter,
		weakness: s.weakness,
		asset: s.asset,
		inboxes: s.inboxes,
		activities: [],
		attachments: [],
	};
}

// Derive the filter token for an assignee. The /reports assignee filter matches on the
// username for users and the display name for groups (it has no id-based form), so that's
// what we store as the option's `value`. Returns null when the needed field is absent.
function assigneeOptionFromRef(a: AssigneeRef): AssigneeOption | null {
	if (a.type === "group") {
		return a.name
			? { type: "group", value: a.name, label: a.name, profile_picture_url: a.profile_picture_url }
			: null;
	}
	return a.username
		? {
				type: "user",
				value: a.username,
				label: a.name ?? a.username,
				profile_picture_url: a.profile_picture_url,
			}
		: null;
}

// Fold the assignees seen on a batch of reports into the accumulated options for `handle`,
// deduping by value and keeping them sorted by label. Returns the same map reference when
// nothing new was learned, so the localStorage-persisting effect can skip a no-op write.
function accumulateAssigneeOptions(
	existing: Record<string, AssigneeOption[]>,
	handle: string | undefined,
	items: ReportSummary[],
): Record<string, AssigneeOption[]> {
	if (!handle) return existing;
	const current = existing[handle] ?? [];
	const byValue = new Map<string, AssigneeOption>(current.map((o) => [o.value, o]));
	let changed = false;
	for (const r of items) {
		if (!r.assignee) continue;
		const option = assigneeOptionFromRef(r.assignee);
		if (!option || byValue.has(option.value)) continue;
		byValue.set(option.value, option);
		changed = true;
	}
	if (!changed) return existing;
	const merged = [...byValue.values()].sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
	);
	return { ...existing, [handle]: merged };
}

function applyDetailToReports(
	reports: AppState["reports"],
	reportId: string,
	detail: ReportDetail,
): AppState["reports"] {
	if (reports.status !== "ready") return reports;
	let changed = false;
	const items = reports.data.items.map((r) => {
		if (r.id !== reportId) return r;
		const sameAsset = (r.asset?.id ?? null) === (detail.asset?.id ?? null);
		if (
			r.title === detail.title &&
			r.state === detail.state &&
			r.severity_rating === detail.severity_rating &&
			r.issue_tracker_reference_id === detail.issue_tracker_reference_id &&
			r.issue_tracker_reference_url === detail.issue_tracker_reference_url &&
			r.reporter.id === detail.reporter.id &&
			sameAsset &&
			sameInboxes(r.inboxes, detail.inboxes)
		) {
			return r;
		}
		changed = true;
		return {
			...r,
			title: detail.title,
			state: detail.state,
			severity_rating: detail.severity_rating,
			issue_tracker_reference_id: detail.issue_tracker_reference_id,
			issue_tracker_reference_url: detail.issue_tracker_reference_url,
			asset: detail.asset,
			reporter: detail.reporter,
			inboxes: detail.inboxes,
		};
	});
	if (!changed) return reports;
	return { ...reports, data: { ...reports.data, items } };
}

function describeNewActivity(activity: Activity): string {
	const actor = activity.actor?.username ?? "system";
	if (activity.type === "comment") {
		return `New comment by ${actor}`;
	}
	if (activity.kind.startsWith("bug-")) {
		const newState = activity.kind.slice("bug-".length);
		return `Report changed to ${pillFor(newState).label} by ${actor}`;
	}
	const kindLabel = activity.kind.replace(/-/g, " ");
	return `${actor} ${kindLabel}`;
}

function describeDetailChange(field: string, next: ReportDetail): string | null {
	switch (field) {
		case "title":
			return "Title updated";
		case "vulnerability_information":
			return "Description updated";
		case "severity_rating":
			return next.severity_rating
				? `Severity changed to ${next.severity_rating}`
				: "Severity cleared";
		case "asset":
			return next.asset ? `Asset changed to ${next.asset.asset_identifier}` : "Asset cleared";
		default:
			return null;
	}
}

let toastSeq = 0;
function makeToast(
	reportId: string,
	message: string,
	activityId?: string,
	activity?: Activity,
): DetailToast {
	toastSeq += 1;
	return { id: `${Date.now()}-${toastSeq}`, reportId, message, activityId, activity };
}

// Compare two ReportDetail snapshots and produce toasts describing what changed.
// Detail-field changes and new activities are reported independently; each category
// aggregates to a single summary toast once it has three or more items.
function diffReportDetail(prev: ReportDetail, next: ReportDetail, reportId: string): DetailToast[] {
	const toasts: DetailToast[] = [];

	const prevIds = new Set(prev.activities.map((a) => a.id));
	const newActivities = next.activities.filter((a) => !prevIds.has(a.id));
	if (newActivities.length === 1) {
		const a = newActivities[0];
		toasts.push(makeToast(reportId, describeNewActivity(a), a.id, a));
	} else if (newActivities.length === 2) {
		for (const a of newActivities) {
			toasts.push(makeToast(reportId, describeNewActivity(a), a.id, a));
		}
	} else if (newActivities.length > 2) {
		// Summary toast jumps to the first new activity — the others are immediately
		// after it in the thread, so a single scroll target is enough.
		toasts.push(makeToast(reportId, `${newActivities.length} new activities`, newActivities[0].id));
	}

	const changedFields: string[] = [];
	if (prev.title !== next.title) changedFields.push("title");
	if (prev.vulnerability_information !== next.vulnerability_information)
		changedFields.push("vulnerability_information");
	if (prev.severity_rating !== next.severity_rating) changedFields.push("severity_rating");
	if ((prev.asset?.id ?? null) !== (next.asset?.id ?? null)) changedFields.push("asset");

	if (changedFields.length === 1) {
		const msg = describeDetailChange(changedFields[0], next);
		if (msg) toasts.push(makeToast(reportId, msg));
	} else if (changedFields.length === 2) {
		for (const f of changedFields) {
			const msg = describeDetailChange(f, next);
			if (msg) toasts.push(makeToast(reportId, msg));
		}
	} else if (changedFields.length > 2) {
		toasts.push(makeToast(reportId, `${changedFields.length} new changes were loaded`));
	}

	return toasts;
}
