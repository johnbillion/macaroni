import { DEFAULT_SEVERITY_KEYS, DEFAULT_STATE_KEYS } from "./filters";

export type AppError =
	| { kind: "unauthorized"; message: string }
	| { kind: "forbidden"; message: string }
	| { kind: "not_found"; message: string }
	| { kind: "rate_limited"; message: string }
	| { kind: "network"; message: string }
	| { kind: "other"; message: string };

export type AsyncState<T> =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; data: T }
	| { status: "error"; error: AppError };

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
	state: string;
	severity_rating: string | null;
	created_at: string;
	last_activity_at: string | null;
	issue_tracker_reference_id: string | null;
	issue_tracker_reference_url: string | null;
	asset: AssetRef | null;
	reporter: UserRef;
	assignee: AssigneeRef | null;
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
export type WeaknessRef = { id: string; name: string; external_id: string | null };
export type AssetRef = { id: string; asset_identifier: string; asset_type: string | null };

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
			old_scope: string | null;
			new_scope: string | null;
			new_weakness: string | null;
			group_name: string | null;
	  };

export type ReportDetail = {
	id: string;
	title: string;
	state: string;
	main_state: string;
	severity_rating: string | null;
	created_at: string;
	submitted_at: string | null;
	vulnerability_information: string;
	issue_tracker_reference_id: string | null;
	issue_tracker_reference_url: string | null;
	reporter: UserRef;
	weakness: WeaknessRef | null;
	asset: AssetRef | null;
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

export type BulkFailure = { reportId: string; error: AppError };

export type BulkOperationState =
	| { status: "idle" }
	| {
			status: "running";
			total: number;
			completed: number;
			currentReportId: string | null;
			failed: BulkFailure[];
			cancelRequested: boolean;
	  }
	| {
			status: "done";
			total: number;
			succeeded: number;
			failed: BulkFailure[];
			cancelled: boolean;
	  };

export type AppState = {
	credentials: "unknown" | "missing" | "present";
	username: string | null;
	bootstrap: AsyncState<{ orgs: Organization[] }>;
	programsByOrg: Record<string, AsyncState<Program[]>>;
	assetsByOrg: Record<string, AsyncState<Asset[]>>;
	teamMembersByProgram: Record<string, AsyncState<TeamMember[]>>;
	filters: {
		orgId?: string;
		programHandle?: string;
		states: string[];
		severities: string[];
		assets: string[];
		search: string;
	};
	reports: AsyncState<{ items: ReportSummary[]; nextCursor?: string }>;
	reportsRefreshing: boolean;
	// Set when a load-more (append) request fails. The existing list is preserved so the user
	// can see what was already loaded; the footer surfaces this error with a retry affordance.
	reportsLoadMoreError: AppError | null;
	// Bumped each time the report list is replaced (filter change), not on append (load-more).
	// Consumers watch this to react to "fresh list" events — e.g. scrolling back to the top.
	reportsReplaceCount: number;
	selectedReportId: string | null;
	// Multi-selection for bulk-edit mode. Non-empty Set => app is in bulk-edit mode.
	selectedReportIds: Set<string>;
	bulkOperation: BulkOperationState;
	detailActiveTab: "report" | "bulk";
	detail: Record<string, AsyncState<ReportDetail>>;
	// Transient notifications surfaced inside the detail pane after a background refresh
	// turns up new activity or detail changes. Tied to the currently selected report only —
	// cleared on REPORT_SELECTED so they don't bleed across navigations.
	detailToasts: DetailToast[];
	readReports: Record<string, true>;
	detailPlacement: DetailPlacement;
	panelSizes: PanelSizes;
	viewport: Viewport;
};

export type Action =
	| { type: "CREDENTIALS_KNOWN"; present: boolean; username: string | null }
	| { type: "CREDENTIALS_SAVED"; username: string }
	| { type: "CREDENTIALS_CLEARED" }
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
	| { type: "SEARCH_SET"; search: string }
	| { type: "REPORTS_REQUESTED"; append: boolean }
	| { type: "REPORTS_SUCCEEDED"; items: ReportSummary[]; nextCursor?: string; append: boolean }
	| { type: "REPORTS_FAILED"; error: AppError; append: boolean }
	| { type: "REPORT_SELECTED"; reportId: string | null }
	| { type: "SELECTION_TOGGLED"; reportId: string }
	| { type: "SELECTION_SET"; reportIds: string[]; checked: boolean }
	| { type: "SELECTION_CLEARED" }
	| { type: "BULK_STARTED"; total: number }
	| { type: "BULK_ITEM_BEGAN"; reportId: string }
	| { type: "BULK_ITEM_SUCCEEDED"; reportId: string; asset: AssetRef }
	| { type: "BULK_ITEM_FAILED"; reportId: string; error: AppError }
	| { type: "BULK_CANCEL_REQUESTED" }
	| { type: "BULK_FINISHED"; cancelled: boolean }
	| { type: "BULK_RESULT_DISMISSED" }
	| { type: "BULK_RETRY_FAILED" }
	| { type: "DETAIL_TAB_SET"; tab: "report" | "bulk" }
	| { type: "DETAIL_REQUESTED"; reportId: string }
	| { type: "DETAIL_SUCCEEDED"; reportId: string; detail: ReportDetail }
	| { type: "DETAIL_FAILED"; reportId: string; error: AppError }
	| { type: "DETAIL_REFRESHED"; reportId: string; detail: ReportDetail }
	| { type: "DETAIL_TOAST_DISMISSED"; toastId: string }
	| { type: "READ_IDS_LOADED"; ids: string[] }
	| { type: "REPORT_MARKED_READ"; reportId: string }
	| { type: "REPORTS_MARKED_READ"; reportIds: string[] }
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

export const initialState: AppState = {
	credentials: "unknown",
	username: null,
	bootstrap: { status: "idle" },
	programsByOrg: {},
	assetsByOrg: {},
	teamMembersByProgram: {},
	filters: {
		states: [...DEFAULT_STATE_KEYS],
		severities: [...DEFAULT_SEVERITY_KEYS],
		assets: [],
		search: "",
	},
	reports: { status: "idle" },
	reportsRefreshing: false,
	reportsLoadMoreError: null,
	reportsReplaceCount: 0,
	selectedReportId: null,
	selectedReportIds: new Set(),
	bulkOperation: { status: "idle" },
	detailActiveTab: "report",
	detail: {},
	detailToasts: [],
	readReports: {},
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
				detailPlacement: state.detailPlacement,
				panelSizes: state.panelSizes,
				viewport: state.viewport,
			};
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
					search: state.filters.search,
				},
				reports: { status: "idle" },
				selectedReportId: null,
				selectedReportIds: new Set(),
				bulkOperation: { status: "idle" },
			};
		case "PROGRAM_SELECTED":
			return {
				...state,
				filters: { ...state.filters, programHandle: action.handle },
				reports: { status: "idle" },
				selectedReportId: null,
				selectedReportIds: new Set(),
				bulkOperation: { status: "idle" },
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
		case "SEARCH_SET":
			return {
				...state,
				filters: { ...state.filters, search: action.search },
			};
		case "REPORTS_REQUESTED":
			return {
				...state,
				reportsRefreshing: true,
				reportsLoadMoreError: null,
				reports: state.reports.status === "ready" ? state.reports : { status: "loading" },
			};
		case "REPORTS_SUCCEEDED": {
			const existing =
				action.append && state.reports.status === "ready" ? state.reports.data.items : [];
			const items = [...existing, ...action.items];
			const stillPresent =
				state.selectedReportId !== null && items.some((r) => r.id === state.selectedReportId);
			// On a fresh list (replace, not append) with no preserved selection, auto-select the
			// first row so the detail pane populates without requiring a manual click.
			const nextSelected = stillPresent
				? state.selectedReportId
				: action.append
					? null
					: (items[0]?.id ?? null);
			return {
				...state,
				reportsRefreshing: false,
				reportsLoadMoreError: null,
				reportsReplaceCount: action.append
					? state.reportsReplaceCount
					: state.reportsReplaceCount + 1,
				selectedReportId: nextSelected,
				reports: {
					status: "ready",
					data: { items, nextCursor: action.nextCursor },
				},
			};
		}
		case "REPORTS_FAILED":
			// On load-more (append) failure, keep the existing list intact and surface the
			// error transiently in the footer so the user can retry without losing context.
			if (action.append && state.reports.status === "ready") {
				return {
					...state,
					reportsRefreshing: false,
					reportsLoadMoreError: action.error,
				};
			}
			return {
				...state,
				reportsRefreshing: false,
				reportsLoadMoreError: null,
				reports: { status: "error", error: action.error },
			};
		case "REPORT_SELECTED":
			return {
				...state,
				selectedReportId: action.reportId,
				detailToasts: [],
			};
		case "SELECTION_TOGGLED": {
			const next = new Set(state.selectedReportIds);
			if (next.has(action.reportId)) next.delete(action.reportId);
			else next.add(action.reportId);
			return { ...state, selectedReportIds: next };
		}
		case "SELECTION_SET": {
			const next = new Set(state.selectedReportIds);
			for (const id of action.reportIds) {
				if (action.checked) next.add(id);
				else next.delete(id);
			}
			return { ...state, selectedReportIds: next };
		}
		case "SELECTION_CLEARED":
			return { ...state, selectedReportIds: new Set() };
		case "BULK_STARTED":
			return {
				...state,
				bulkOperation: {
					status: "running",
					total: action.total,
					completed: 0,
					currentReportId: null,
					failed: [],
					cancelRequested: false,
				},
			};
		case "BULK_ITEM_BEGAN": {
			if (state.bulkOperation.status !== "running") return state;
			return {
				...state,
				bulkOperation: { ...state.bulkOperation, currentReportId: action.reportId },
			};
		}
		case "BULK_ITEM_SUCCEEDED": {
			if (state.bulkOperation.status !== "running") return state;
			let nextReports = state.reports;
			if (state.reports.status === "ready") {
				const items = state.reports.data.items.map((r) =>
					r.id === action.reportId ? { ...r, asset: action.asset } : r,
				);
				nextReports = { status: "ready", data: { ...state.reports.data, items } };
			}
			const restDetail = { ...state.detail };
			delete restDetail[action.reportId];
			return {
				...state,
				reports: nextReports,
				detail: restDetail,
				bulkOperation: {
					...state.bulkOperation,
					completed: state.bulkOperation.completed + 1,
				},
			};
		}
		case "BULK_ITEM_FAILED": {
			if (state.bulkOperation.status !== "running") return state;
			return {
				...state,
				bulkOperation: {
					...state.bulkOperation,
					completed: state.bulkOperation.completed + 1,
					failed: [
						...state.bulkOperation.failed,
						{ reportId: action.reportId, error: action.error },
					],
				},
			};
		}
		case "BULK_CANCEL_REQUESTED": {
			if (state.bulkOperation.status !== "running") return state;
			return {
				...state,
				bulkOperation: { ...state.bulkOperation, cancelRequested: true },
			};
		}
		case "BULK_FINISHED": {
			if (state.bulkOperation.status !== "running") return state;
			const { total, completed, failed } = state.bulkOperation;
			return {
				...state,
				bulkOperation: {
					status: "done",
					total,
					succeeded: completed - failed.length,
					failed,
					cancelled: action.cancelled,
				},
			};
		}
		case "BULK_RESULT_DISMISSED":
			return { ...state, bulkOperation: { status: "idle" } };
		case "BULK_RETRY_FAILED": {
			if (state.bulkOperation.status !== "done") return state;
			const failedIds = state.bulkOperation.failed.map((f) => f.reportId);
			return {
				...state,
				selectedReportIds: new Set(failedIds),
				bulkOperation: { status: "idle" },
			};
		}
		case "DETAIL_TAB_SET":
			return { ...state, detailActiveTab: action.tab };
		case "DETAIL_REQUESTED":
			return {
				...state,
				detail: { ...state.detail, [action.reportId]: { status: "loading" } },
			};
		case "DETAIL_SUCCEEDED":
			// The inbox row was loaded from /reports earlier — it may be stale by the time
			// the user clicks in. Reconcile it against the freshly fetched detail so the
			// summary fields (state, severity, title, asset, etc.) match what's in the pane.
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "ready", data: action.detail },
				},
				reports: applyDetailToReports(state.reports, action.reportId, action.detail),
			};
		case "DETAIL_FAILED":
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "error", error: action.error },
				},
			};
		case "DETAIL_REFRESHED": {
			const existing = state.detail[action.reportId];
			const nextDetail: AppState["detail"] = {
				...state.detail,
				[action.reportId]: { status: "ready", data: action.detail },
			};
			const nextReports = applyDetailToReports(state.reports, action.reportId, action.detail);
			// First time the data lands (refresh raced ahead of the initial fetch finishing) —
			// no prior data to diff against, so just install the detail with no toasts.
			if (!existing || existing.status !== "ready") {
				return { ...state, detail: nextDetail, reports: nextReports };
			}
			// Only surface toasts when the refresh is for the currently selected report —
			// otherwise the user would see notifications inside a pane that isn't visible.
			if (state.selectedReportId !== action.reportId) {
				return { ...state, detail: nextDetail, reports: nextReports };
			}
			const newToasts = diffReportDetail(existing.data, action.detail, action.reportId);
			return {
				...state,
				detail: nextDetail,
				reports: nextReports,
				detailToasts: [...state.detailToasts, ...newToasts],
			};
		}
		case "DETAIL_TOAST_DISMISSED":
			return {
				...state,
				detailToasts: state.detailToasts.filter((t) => t.id !== action.toastId),
			};
		case "READ_IDS_LOADED": {
			const next: Record<string, true> = { ...state.readReports };
			for (const id of action.ids) next[id] = true;
			return { ...state, readReports: next };
		}
		case "REPORT_MARKED_READ":
			return {
				...state,
				readReports: { ...state.readReports, [action.reportId]: true },
			};
		case "REPORTS_MARKED_READ": {
			const next: Record<string, true> = { ...state.readReports };
			for (const id of action.reportIds) next[id] = true;
			return { ...state, readReports: next };
		}
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

// Reconcile the inbox-list row for `reportId` against a freshly fetched detail. Only the
// fields that overlap between ReportSummary and ReportDetail are touched; everything else
// (assignee, last_activity_at) is left as-is since the detail endpoint doesn't carry it.
// Returns the same reports state reference when nothing actually changed so consumers can
// skip re-renders via reference identity.
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
			sameAsset
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
function makeToast(reportId: string, message: string, activityId?: string): DetailToast {
	toastSeq += 1;
	return { id: `${Date.now()}-${toastSeq}`, reportId, message, activityId };
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
		toasts.push(makeToast(reportId, describeNewActivity(a), a.id));
	} else if (newActivities.length === 2) {
		for (const a of newActivities) {
			toasts.push(makeToast(reportId, describeNewActivity(a), a.id));
		}
	} else if (newActivities.length > 2) {
		// Summary toast jumps to the first new activity — the others are immediately
		// after it in the thread, so a single scroll target is enough.
		toasts.push(
			makeToast(reportId, `${newActivities.length} new activities`, newActivities[0].id),
		);
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
