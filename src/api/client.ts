import { invoke } from "@tauri-apps/api/core";
import type {
	AppError,
	DuplicateInput,
	DuplicateResult,
	InboxRef,
	Organization,
	Program,
	ReportDetail,
	ReportSummary,
	Settings,
	TeamMember,
	TriageRecord,
} from "../state/store";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return (await invoke(cmd, args)) as T;
	} catch (e) {
		throw e as AppError;
	}
}

export const api = {
	credentialsStatus: () =>
		call<{ has_credentials: boolean; username: string | null }>("credentials_status"),
	credentialsSave: (username: string, token: string) =>
		call<void>("credentials_save", { username, token }),
	// Forget the credentials, optionally deleting the local report mirror as well.
	logOut: (deleteDatabase: boolean) => call<void>("log_out", { deleteDatabase }),
	listOrganizations: () => call<Organization[]>("list_organizations"),
	listPrograms: (orgId: string) => call<Program[]>("list_programs", { orgId }),
	listProgramMembers: (programId: string) =>
		call<TeamMember[]>("list_program_members", { programId }),
	// Query the local SQLite mirror. Returns every matching report (no pagination).
	queryReports: (query: {
		program_handle: string;
		states: string[];
		severities: string[];
		asset_identifiers: string[];
		assignees: string[];
		inbox_ids: string[];
		keyword?: string;
		whole_words?: boolean;
	}) => call<ReportSummary[]>("query_reports", { query }),
	// Distinct inboxes across all reports synced for a program, for the sidebar inbox filter.
	listInboxes: (programHandle: string) => call<InboxRef[]>("list_inboxes", { programHandle }),
	// Distinct asset identifiers across a program's synced reports, for the sidebar asset filter.
	listLocalAssets: (programHandle: string) =>
		call<string[]>("list_local_assets", { programHandle }),
	// Handles of the programs already mirrored locally, for selecting one at launch without
	// waiting on the HackerOne API.
	listLocalPrograms: () => call<string[]>("list_local_programs"),
	syncedReportCount: (programHandle: string) =>
		call<number>("synced_report_count", { programHandle }),
	startReportSync: (programHandle: string) => call<void>("start_report_sync", { programHandle }),
	getReport: (reportId: string) => call<ReportDetail>("get_report", { reportId }),
	// The locally-cached full detail for a report, if the sync has fetched it. Null if not.
	getCachedReport: (reportId: string) =>
		call<ReportDetail | null>("get_cached_report", { reportId }),
	saveAttachment: (url: string, suggestedFilename: string) =>
		call<boolean>("save_attachment", { url, suggestedFilename }),
	saveTextFile: (contents: string, suggestedFilename: string) =>
		call<boolean>("save_text_file", { contents, suggestedFilename }),
	saveZipFile: (entries: { filename: string; contents: string }[], suggestedFilename: string) =>
		call<boolean>("save_zip_file", { entries, suggestedFilename }),
	// The macOS system accent colour, for driving the theme's --accent / --on-accent vars.
	getAccentColor: () => call<{ accent: string; on_accent: string }>("get_accent_color"),
	getSettings: () => call<Settings>("get_settings"),
	setTriageWorkingDir: (dir: string | null) => call<Settings>("set_triage_working_dir", { dir }),
	setTriagePrompt: (prompt: string | null) => call<Settings>("set_triage_prompt", { prompt }),
	getDefaultTriagePrompt: () => call<string>("get_default_triage_prompt"),
	pickDirectory: () => call<string | null>("pick_directory"),
	getTriage: (reportId: string) => call<TriageRecord | null>("get_triage", { reportId }),
	// The pasteable `cd … && claude --resume …` command for a finished triage run.
	triageResumeCommand: (sessionId: string) => call<string>("triage_resume_command", { sessionId }),
	getTriagePrompt: (reportTitle: string, reportBody: string) =>
		call<string>("get_triage_prompt", { reportTitle, reportBody }),
	runTriage: (reportId: string, prompt: string) =>
		call<TriageRecord>("run_triage", { reportId, prompt }),
	stopTriage: (reportId: string) => call<boolean>("stop_triage", { reportId }),
	// Ask Claude whether the supplied reports are duplicates of one another. `requestId` keys
	// both the streamed event channel and the stop signal.
	runDuplicates: (requestId: string, reports: DuplicateInput[]) =>
		call<DuplicateResult>("run_duplicates", { requestId, reports }),
	stopDuplicates: (requestId: string) => call<boolean>("stop_duplicates", { requestId }),
	// Delete one of a report's triage new-files from disk; resolves to the remaining paths.
	deleteTriageFile: (reportId: string, path: string) =>
		call<string[]>("delete_triage_file", { reportId, path }),
	listTriageValidity: (reportIds: string[]) =>
		call<{ id: string; validity: string | null }[]>("list_triage_validity", { reportIds }),
};
