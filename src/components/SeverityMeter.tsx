const FILLS: Record<string, number> = {
	none: 1,
	low: 2,
	medium: 3,
	high: 4,
	critical: 5,
};

const LABELS: Record<string, string> = {
	none: "None",
	low: "Low",
	medium: "Medium",
	high: "High",
	critical: "Critical",
};

export function SeverityMeter({
	rating,
	showLabel = false,
}: {
	rating?: string | null;
	showLabel?: boolean;
}) {
	const key = (rating ?? "").toLowerCase();
	const fill = FILLS[key] ?? 0;
	const label = LABELS[key] ?? "No rating";
	return (
		<span class="sev-meter" data-rating={fill === 0 ? "none-set" : key}>
			<span class="sev-bars" role="img" aria-label={`Severity: ${label}`}>
				{[0, 1, 2, 3, 4].map((i) => (
					<span key={i} class={`sev-bar ${i < fill ? "on" : ""}`} />
				))}
			</span>
			{showLabel && <span class="sev-label">{label}</span>}
		</span>
	);
}
