#!/usr/bin/env node
// Usage: node --env-file=.env inboxes.js <program-handle>

const [, , programHandle] = process.argv;
const user = process.env.H1_USER;
const token = process.env.H1_TOKEN;

if (!user || !token) {
	console.error("Missing H1_USER or H1_TOKEN environment variable.");
	process.exit(1);
}
if (!programHandle) {
	console.error("Usage: node --env-file=.env inboxes.js <program-handle>");
	process.exit(1);
}

const auth = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
const base = "https://api.hackerone.com/v1";

async function api(path) {
	const res = await fetch(`${base}${path}`, {
		headers: { Authorization: auth, Accept: "application/json" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
	return res.json();
}

(async () => {
	const programs = await api("/me/programs?page[size]=100");
	const summary = programs.data.find((p) => p.attributes.handle === programHandle);
	if (!summary) {
		console.error(`Program "${programHandle}" not found in your accessible programs.`);
		process.exit(1);
	}
	const program = (await api(`/programs/${summary.id}`)).data;
	const orgId = program.relationships?.organization?.data?.id;
	if (!orgId) {
		console.error("Program has no organization relationship.");
		process.exit(1);
	}

	const inboxes = await api(`/organizations/${orgId}/inboxes?page[size]=100`);
	for (const i of inboxes.data) {
		console.log(`${i.id}\t${i.attributes.name}`);
	}
	console.error(`\n${inboxes.data.length} inbox(es).`);
})().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
