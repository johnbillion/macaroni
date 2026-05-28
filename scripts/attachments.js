#!/usr/bin/env node
// Usage:
//   node attachments.js <report-id>
// Reads HackerOne credentials from the app's macOS keychain entry.

import { execFileSync } from "node:child_process";

const [, , reportId] = process.argv;
if (!reportId) {
	console.error("Usage: node attachments.js <report-id>");
	process.exit(1);
}

let creds;
try {
	const json = execFileSync(
		"security",
		["find-generic-password", "-s", "com.johnbillion.macaroni", "-a", "default", "-w"],
		{ encoding: "utf8" },
	).trim();
	creds = JSON.parse(json);
} catch (e) {
	console.error("Failed to read credentials from keychain:", e.message);
	process.exit(1);
}

const auth = `Basic ${Buffer.from(`${creds.username}:${creds.token}`).toString("base64")}`;
const url = `https://api.hackerone.com/v1/reports/${reportId}`;

const res = await fetch(url, {
	headers: { Authorization: auth, Accept: "application/json" },
});
if (!res.ok) {
	console.error(`HTTP ${res.status} ${res.statusText}`);
	console.error(await res.text());
	process.exit(1);
}
const body = await res.json();

const rel = body.data?.relationships ?? {};
const attachments = rel.attachments?.data ?? [];
const included = body.included ?? [];

const lookup = new Map();
for (const inc of included) lookup.set(`${inc.type}:${inc.id}`, inc);

console.log(`Report #${reportId}: ${body.data?.attributes?.title ?? "(no title)"}`);
console.log(`\nTop-level attachments: ${attachments.length}`);
for (const ref of attachments) {
	const full = lookup.get(`${ref.type}:${ref.id}`) ?? ref;
	const a = full.attributes ?? {};
	console.log(
		`  - id=${ref.id}  ${a.file_name ?? "(no name)"}  ${a.content_type ?? ""}  ${a.file_size ?? "?"}b`,
	);
	if (a.expiring_url) console.log(`    url: ${a.expiring_url}`);
}

// Also pull included attachments that may be referenced from activities/comments.
const allAttachments = included.filter((i) => i.type === "attachment");
const inlineOnly = allAttachments.filter((i) => !attachments.find((r) => r.id === i.id));
console.log(`\nOther attachments in 'included' (likely inline/comment): ${inlineOnly.length}`);
for (const inc of inlineOnly) {
	const a = inc.attributes ?? {};
	console.log(
		`  - id=${inc.id}  ${a.file_name ?? "(no name)"}  ${a.content_type ?? ""}  ${a.file_size ?? "?"}b`,
	);
}
