import type { AppState } from "./store";

// Suggested-bounty activities carry no currency; a program pays in a single currency, so borrow
// it from the first awarded bounty in the loaded inbox list.
export function programCurrencyOf(state: AppState): string | null {
	return state.reports.status === "ready"
		? (state.reports.data.items.find((it) => it.bounty?.currency)?.bounty?.currency ?? null)
		: null;
}
