#!/usr/bin/env node
// Usage: node --env-file=.env assign-inbox.js <inbox-id> <report-id> [report-id ...]

const [, , inboxIdArg, ...reportIds] = process.argv;
const user = process.env.H1_USER;
const token = process.env.H1_TOKEN;

if (!user || !token) {
	console.error("Missing H1_USER or H1_TOKEN environment variable.");
	process.exit(1);
}
if (!inboxIdArg || reportIds.length === 0) {
	console.error(
		"Usage: node --env-file=.env assign-inbox.js <inbox-id> <report-id> [report-id ...]",
	);
	process.exit(1);
}

const inboxId = Number(inboxIdArg);
const auth = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
const base = "https://api.hackerone.com/v1";

async function assign(reportId) {
	const res = await fetch(`${base}/reports/${reportId}/inboxes`, {
		method: "POST",
		headers: {
			Authorization: auth,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			data: { organization_inbox_ids: [inboxId] },
		}),
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`#${reportId}: HTTP ${res.status} ${res.statusText}: ${body}`);
	}
	return body;
}

(async () => {
	for (const id of reportIds) {
		try {
			await assign(id);
			console.log(`#${id}\tassigned to inbox ${inboxId}`);
		} catch (err) {
			console.error(err.message);
		}
	}
})();
