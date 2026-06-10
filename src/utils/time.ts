export function formatRelativeTime(isoDate: string): string {
	const then = new Date(isoDate);
	if (Number.isNaN(then.getTime())) return "";
	const now = Date.now();
	const diffSec = Math.max(0, Math.round((now - then.getTime()) / 1000));

	if (diffSec < 60) return `${diffSec}s ago`;
	if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
	if (diffSec < (86400*2)) return `${Math.round(diffSec / 3600)}h ago`;

	const sameYear = then.getFullYear() === new Date(now).getFullYear();
	return then.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	});
}

export function formatClock(isoDate: string): string {
	const d = new Date(isoDate);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
