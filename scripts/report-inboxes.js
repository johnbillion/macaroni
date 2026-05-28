#!/usr/bin/env node
// Usage: node --env-file=.env report-inboxes.js <report-id>

const [, , reportId] = process.argv;
const user = process.env.H1_USER;
const token = process.env.H1_TOKEN;

if (!user || !token) {
	console.error("Missing H1_USER or H1_TOKEN environment variable.");
	process.exit(1);
}
if (!reportId) {
	console.error("Usage: node --env-file=.env report-inboxes.js <report-id>");
	process.exit(1);
}

const auth = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

(async () => {
	const res = await fetch(`https://api.hackerone.com/v1/reports/${reportId}`, {
		headers: { Authorization: auth, Accept: "application/json" },
	});
	if (!res.ok) {
		console.error(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
		process.exit(1);
	}
	const { data } = await res.json();
	const inboxes = data.relationships?.inboxes?.data || [];
	for (const i of inboxes) {
		console.log(`${i.id}\t${i.attributes.type}\t${i.attributes.name}`);
	}
	console.error(`\n${inboxes.length} inbox(es).`);
})();
