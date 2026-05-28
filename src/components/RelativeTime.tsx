import { useEffect, useState } from "preact/hooks";
import { formatRelativeTime } from "../utils/time";

// Module-level scheduler shared by every <RelativeTime> on screen so the relative-time
// labels all refresh in lockstep — one timer instead of one per instance — and parent
// components don't have to re-render just to update a "5m ago" string.
const RELATIVE_TIME_TICK_MS = 10_000;
const listeners = new Set<() => void>();
let intervalId: number | null = null;

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	if (intervalId === null) {
		intervalId = window.setInterval(() => {
			for (const l of listeners) l();
		}, RELATIVE_TIME_TICK_MS);
	}
	return () => {
		listeners.delete(cb);
		if (listeners.size === 0 && intervalId !== null) {
			window.clearInterval(intervalId);
			intervalId = null;
		}
	};
}

export function RelativeTime({ iso }: { iso: string }) {
	const [text, setText] = useState(() => formatRelativeTime(iso));
	useEffect(() => {
		setText(formatRelativeTime(iso));
		return subscribe(() => setText(formatRelativeTime(iso)));
	}, [iso]);
	return <>{text}</>;
}
