import { invoke } from "@tauri-apps/api/core";
import type { AppError, Organization, Program, ReportDetail, ReportSummary } from "../state/store";

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
	listReports: (query: { program_handle: string; states: string[]; page_cursor?: string }) =>
		call<{ items: ReportSummary[]; next_cursor: string | null }>("list_reports", { query }),
	getReport: (reportId: string) => call<ReportDetail>("get_report", { reportId }),
	markReportRead: (reportId: string) => call<void>("mark_report_read", { reportId }),
	getReadIds: (reportIds: string[]) => call<string[]>("get_read_ids", { reportIds }),
};
