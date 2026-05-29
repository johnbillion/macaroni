import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "preact";

/** A clickable `#<id>` link to a report on hackerone.com, opened externally. */
export function ReportLink({ id }: { id: string }): JSX.Element {
	const url = `https://hackerone.com/reports/${id}`;
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			onClick={(e) => {
				e.preventDefault();
				openUrl(url);
			}}
		>
			#{id}
		</a>
	);
}
