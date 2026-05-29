import { invoke } from "@tauri-apps/api/core";
import type {
	AppError,
	Asset,
	Organization,
	Program,
	ReportDetail,
	ReportSummary,
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
		keyword?: string;
		page_cursor?: string;
	}) => call<{ items: ReportSummary[]; next_cursor: string | null }>("list_reports", { query }),
	getReport: (reportId: string) => call<ReportDetail>("get_report", { reportId }),
	updateReportAsset: (reportId: string, assetId: string) =>
		call<void>("update_report_asset", { reportId, assetId }),
	saveAttachment: (url: string, suggestedFilename: string) =>
		call<boolean>("save_attachment", { url, suggestedFilename }),
	markReportRead: (reportId: string) => call<void>("mark_report_read", { reportId }),
	markReportsRead: (reportIds: string[]) => call<void>("mark_reports_read", { reportIds }),
	getReadIds: (reportIds: string[]) => call<string[]>("get_read_ids", { reportIds }),
	getTriage: (reportId: string) => call<TriageRecord | null>("get_triage", { reportId }),
	getTriagePrompt: (reportTitle: string, reportBody: string) =>
		call<string>("get_triage_prompt", { reportTitle, reportBody }),
	runTriage: (reportId: string, prompt: string) =>
		call<TriageRecord>("run_triage", { reportId, prompt }),
	stopTriage: (reportId: string) => call<boolean>("stop_triage", { reportId }),
	listTriageValidity: (reportIds: string[]) =>
		call<{ id: string; validity: string | null }[]>("list_triage_validity", { reportIds }),
};
