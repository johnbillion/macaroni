import { invoke } from "@tauri-apps/api/core";
import type {
	AppError,
	Asset,
	Organization,
	Program,
	ReportDetail,
	ReportSummary,
	TeamMember,
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
		page_cursor?: string;
	}) => call<{ items: ReportSummary[]; next_cursor: string | null }>("list_reports", { query }),
	getReport: (reportId: string) => call<ReportDetail>("get_report", { reportId }),
	saveAttachment: (url: string, suggestedFilename: string) =>
		call<boolean>("save_attachment", { url, suggestedFilename }),
	markReportRead: (reportId: string) => call<void>("mark_report_read", { reportId }),
	markReportsRead: (reportIds: string[]) => call<void>("mark_reports_read", { reportIds }),
	getReadIds: (reportIds: string[]) => call<string[]>("get_read_ids", { reportIds }),
};
