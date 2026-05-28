#!/usr/bin/env node
// Usage:
//   node --env-file=.env reports.js <program-handle> [state1,state2,...]

const [, , programHandle, stateFilter] = process.argv;
const user = process.env.H1_USER;
const token = process.env.H1_TOKEN;

if (!user || !token) {
	console.error("Missing H1_USER or H1_TOKEN environment variable.");
	process.exit(1);
}
if (!programHandle) {
	console.error("Usage: node reports.js <program-handle> [state1,state2,...]");
	process.exit(1);
}

const auth = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
const base = "https://api.hackerone.com/v1";

async function fetchPage(url) {
	const res = await fetch(url, {
		headers: { Authorization: auth, Accept: "application/json" },
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
	}
	return res.json();
}

function buildUrl() {
	const params = new URLSearchParams();
	params.append("filter[program][]", programHandle);
	if (stateFilter) {
		for (const s of stateFilter.split(",")) {
			params.append("filter[state][]", s.trim());
		}
	}
	params.set("page[size]", "100");
	params.set("sort", "-reports.created_at");
	return `${base}/reports?${params.toString()}`;
}

(async () => {
	const page = await fetchPage(buildUrl());
	for (const r of page.data) {
		const a = r.attributes;
		console.log(
			[
				`#${r.id}`.padEnd(10),
				(a.state || "").padEnd(16),
				(a.severity_rating || "-").padEnd(8),
				(a.created_at || "").slice(0, 10),
				a.title,
			].join("  "),
		);
	}
	console.error(`\n${page.data.length} report(s).`);
})().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
