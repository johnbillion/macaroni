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
export type ReportSummary = {
	id: string;
	title: string;
	state: string;
	severity_rating: string | null;
	created_at: string;
	asset: AssetRef | null;
};

export type UserRef = {
	id: string;
	username: string;
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

export type AppState = {
	credentials: "unknown" | "missing" | "present";
	username: string | null;
	bootstrap: AsyncState<{ orgs: Organization[] }>;
	programsByOrg: Record<string, AsyncState<Program[]>>;
	filters: {
		orgId?: string;
		programHandle?: string;
		states: string[];
	};
	reports: AsyncState<{ items: ReportSummary[]; nextCursor?: string }>;
	selectedReportId: string | null;
	detail: Record<string, AsyncState<ReportDetail>>;
	readReports: Record<string, true>;
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
	| { type: "ORG_SELECTED"; orgId: string }
	| { type: "PROGRAM_SELECTED"; handle: string }
	| { type: "STATES_SET"; states: string[] }
	| { type: "REPORTS_REQUESTED" }
	| { type: "REPORTS_SUCCEEDED"; items: ReportSummary[]; nextCursor?: string }
	| { type: "REPORTS_FAILED"; error: AppError }
	| { type: "REPORT_SELECTED"; reportId: string | null }
	| { type: "DETAIL_REQUESTED"; reportId: string }
	| { type: "DETAIL_SUCCEEDED"; reportId: string; detail: ReportDetail }
	| { type: "DETAIL_FAILED"; reportId: string; error: AppError }
	| { type: "READ_IDS_LOADED"; ids: string[] }
	| { type: "REPORT_MARKED_READ"; reportId: string };

export const initialState: AppState = {
	credentials: "unknown",
	username: null,
	bootstrap: { status: "idle" },
	programsByOrg: {},
	filters: { states: [] },
	reports: { status: "idle" },
	selectedReportId: null,
	detail: {},
	readReports: {},
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
			return { ...initialState, credentials: "missing" };
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
		case "ORG_SELECTED":
			return {
				...state,
				filters: {
					orgId: action.orgId,
					programHandle: undefined,
					states: state.filters.states,
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
		case "REPORTS_REQUESTED":
			return { ...state, reports: { status: "loading" } };
		case "REPORTS_SUCCEEDED":
			return {
				...state,
				reports: {
					status: "ready",
					data: { items: action.items, nextCursor: action.nextCursor },
				},
			};
		case "REPORTS_FAILED":
			return { ...state, reports: { status: "error", error: action.error } };
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
	}
}
