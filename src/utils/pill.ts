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
};

export function pillFor(state: string): { className: string; label: string } {
	return STATE_TO_PILL[state] ?? { className: "", label: state };
}
