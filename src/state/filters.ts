// Facet definitions and helpers shared by the sidebar UI and the API translation layer.
// Keys for state/severity match the values the HackerOne API expects, so they can be sent
// directly to /reports filters without further translation (except "unrated", which is a
// UI-only sentinel — the API has no way to filter for unrated reports).

export type StateFacet = { key: string; label: string; swatch: string };

export const OPEN_STATES: StateFacet[] = [
	{ key: "new", label: "New", swatch: "state-new" },
	{ key: "needs-more-info", label: "Needs more info", swatch: "state-needs-info" },
	{ key: "triaged", label: "Triaged", swatch: "state-triaged" },
	{ key: "retesting", label: "Retesting", swatch: "state-retesting" },
	{ key: "pending-program-review", label: "Pending program review", swatch: "state-pending" },
];

export const CLOSED_STATES: StateFacet[] = [
	{ key: "duplicate", label: "Duplicate", swatch: "state-duplicate" },
	{ key: "informative", label: "Informative", swatch: "state-informative" },
	{ key: "not-applicable", label: "N/A", swatch: "state-na" },
	{ key: "resolved", label: "Resolved", swatch: "state-resolved" },
	{ key: "spam", label: "Spam", swatch: "state-spam" },
];

export const ALL_STATE_KEYS: string[] = [
	...OPEN_STATES.map((s) => s.key),
	...CLOSED_STATES.map((s) => s.key),
];

export const DEFAULT_STATE_KEYS: string[] = OPEN_STATES.map((s) => s.key);

// Subset of states valid as targets for POST /v1/reports/{id}/state_changes.
// `retesting` and `pending-program-review` are computed states, not directly settable.
const COMPUTED_STATES = new Set(["retesting", "pending-program-review"]);
export const OPEN_STATE_CHANGE_TARGETS: StateFacet[] = OPEN_STATES.filter(
	(s) => !COMPUTED_STATES.has(s.key),
);
export const CLOSED_STATE_CHANGE_TARGETS: StateFacet[] = CLOSED_STATES;
export const STATE_CHANGE_TARGETS: StateFacet[] = [
	...OPEN_STATE_CHANGE_TARGETS,
	...CLOSED_STATE_CHANGE_TARGETS,
];

export type SeverityFacet = { key: string; rating: string | null };

// "unrated" is UI-only — the API can't filter for reports without a severity rating.
export const SEVERITY_FACETS: SeverityFacet[] = [
	{ key: "critical", rating: "critical" },
	{ key: "high", rating: "high" },
	{ key: "medium", rating: "medium" },
	{ key: "low", rating: "low" },
	{ key: "none", rating: "none" },
	{ key: "unrated", rating: null },
];

export const ALL_SEVERITY_KEYS: string[] = SEVERITY_FACETS.map((s) => s.key);

export const DEFAULT_SEVERITY_KEYS: string[] = [];
