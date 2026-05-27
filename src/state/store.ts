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
	asset: AssetRef | null;
	reporter: UserRef | null;
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

export type Activity =
	| {
			type: "comment";
			id: string;
			created_at: string;
			message: string;
			internal: boolean;
			actor: UserRef | null;
	  }
	| {
			type: "event";
			id: string;
			created_at: string;
			kind: string;
			message: string | null;
			internal: boolean;
			actor: UserRef | null;
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
	reporter: UserRef | null;
	weakness: WeaknessRef | null;
	asset: AssetRef | null;
	activities: Activity[];
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

export type AppState = {
	credentials: "unknown" | "missing" | "present";
	username: string | null;
	bootstrap: AsyncState<{ orgs: Organization[] }>;
	programsByOrg: Record<string, AsyncState<Program[]>>;
	assetsByOrg: Record<string, AsyncState<Asset[]>>;
	filters: {
		orgId?: string;
		programHandle?: string;
		states: string[];
		severities: string[];
		assets: string[];
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
	detail: Record<string, AsyncState<ReportDetail>>;
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
	| { type: "ORG_SELECTED"; orgId: string }
	| { type: "PROGRAM_SELECTED"; handle: string }
	| { type: "STATES_SET"; states: string[] }
	| { type: "SEVERITIES_SET"; severities: string[] }
	| { type: "ASSETS_SET"; assets: string[] }
	| { type: "REPORTS_REQUESTED"; append: boolean }
	| { type: "REPORTS_SUCCEEDED"; items: ReportSummary[]; nextCursor?: string; append: boolean }
	| { type: "REPORTS_FAILED"; error: AppError; append: boolean }
	| { type: "REPORT_SELECTED"; reportId: string | null }
	| { type: "DETAIL_REQUESTED"; reportId: string }
	| { type: "DETAIL_SUCCEEDED"; reportId: string; detail: ReportDetail }
	| { type: "DETAIL_FAILED"; reportId: string; error: AppError }
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
	filters: {
		states: [...DEFAULT_STATE_KEYS],
		severities: [...DEFAULT_SEVERITY_KEYS],
		assets: [],
	},
	reports: { status: "idle" },
	reportsRefreshing: false,
	reportsLoadMoreError: null,
	reportsReplaceCount: 0,
	selectedReportId: null,
	detail: {},
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
		case "ORG_SELECTED":
			return {
				...state,
				filters: {
					orgId: action.orgId,
					programHandle: undefined,
					states: state.filters.states,
					severities: state.filters.severities,
					assets: [],
				},
				reports: { status: "idle" },
				selectedReportId: null,
			};
		case "PROGRAM_SELECTED":
			return {
				...state,
				filters: { ...state.filters, programHandle: action.handle },
				reports: { status: "idle" },
				selectedReportId: null,
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
				state.selectedReportId !== null &&
				items.some((r) => r.id === state.selectedReportId);
			return {
				...state,
				reportsRefreshing: false,
				reportsLoadMoreError: null,
				reportsReplaceCount: action.append
					? state.reportsReplaceCount
					: state.reportsReplaceCount + 1,
				selectedReportId: stillPresent ? state.selectedReportId : null,
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
			return { ...state, selectedReportId: action.reportId };
		case "DETAIL_REQUESTED":
			return {
				...state,
				detail: { ...state.detail, [action.reportId]: { status: "loading" } },
			};
		case "DETAIL_SUCCEEDED":
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "ready", data: action.detail },
				},
			};
		case "DETAIL_FAILED":
			return {
				...state,
				detail: {
					...state.detail,
					[action.reportId]: { status: "error", error: action.error },
				},
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
