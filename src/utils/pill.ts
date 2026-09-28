const STATE_TO_PILL: Record<string, { className: string; label: string }> = {
	new: { className: "new", label: "New" },
	"pending-program-review": { className: "pending", label: "Pending" },
	"needs-more-info": { className: "needs", label: "Needs Info" },
	triaged: { className: "triaged", label: "Triaged" },
	retesting: { className: "retesting", label: "Retesting" },
	duplicate: { className: "dup", label: "Duplicate" },
	informative: { className: "informative", label: "Informative" },
	"not-applicable": { className: "na", label: "N/A" },
	resolved: { className: "resolved", label: "Resolved" },
	spam: { className: "spam", label: "Spam" },
	// Only ever seen as a `bug-inactive` activity (a needs-more-info report that timed out); the
	// report itself ends up in one of the closed states above.
	inactive: { className: "inactive", label: "Inactive" },
};

export function pillFor(state: string): { className: string; label: string } {
	return STATE_TO_PILL[state] ?? { className: "", label: state };
}
