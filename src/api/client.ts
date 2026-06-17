import { invoke } from "@tauri-apps/api/core";
import type {
	AppError,
	Asset,
	DuplicateInput,
	DuplicateResult,
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
	credentialsClear: () => call<void>("credentials_clear"),
	listOrganizations: () => call<Organization[]>("list_organizations"),
	listPrograms: (orgId: string) => call<Program[]>("list_programs", { orgId }),
	listAssets: (orgId: string) => call<Asset[]>("list_assets", { orgId }),
	listProgramMembers: (programId: string) =>
		call<TeamMember[]>("list_program_members", { programId }),
	listReports: (query: {
		program_handle: string;
		states: string[];
		severities: string[];
		asset_ids: string[];
		assignees: string[];
		keyword?: string;
		page_cursor?: string;
		since_created_at?: string;
	}) => call<{ items: ReportSummary[]; next_cursor: string | null }>("list_reports", { query }),
	getReport: (reportId: string) => call<ReportDetail>("get_report", { reportId }),
	updateReportAsset: (reportId: string, assetId: string) =>
		call<void>("update_report_asset", { reportId, assetId }),
	saveAttachment: (url: string, suggestedFilename: string) =>
		call<boolean>("save_attachment", { url, suggestedFilename }),
	saveTextFile: (contents: string, suggestedFilename: string) =>
		call<boolean>("save_text_file", { contents, suggestedFilename }),
	saveZipFile: (entries: { filename: string; contents: string }[], suggestedFilename: string) =>
		call<boolean>("save_zip_file", { entries, suggestedFilename }),
	getSettings: () => call<Settings>("get_settings"),
	setTriageWorkingDir: (dir: string | null) => call<Settings>("set_triage_working_dir", { dir }),
	pickDirectory: () => call<string | null>("pick_directory"),
	getTriage: (reportId: string) => call<TriageRecord | null>("get_triage", { reportId }),
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
