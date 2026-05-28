#!/usr/bin/env node
// Usage:
//   node report-raw.js <report-id>
// Prints the raw vulnerability_information markdown for a report.

import { execFileSync } from "node:child_process";

const [, , reportId] = process.argv;
if (!reportId) {
	console.error("Usage: node report-raw.js <report-id>");
	process.exit(1);
}

const json = execFileSync(
	"security",
	["find-generic-password", "-s", "com.johnbillion.macaroni", "-a", "default", "-w"],
	{ encoding: "utf8" },
).trim();
const creds = JSON.parse(json);
const auth = `Basic ${Buffer.from(`${creds.username}:${creds.token}`).toString("base64")}`;

const res = await fetch(`https://api.hackerone.com/v1/reports/${reportId}`, {
	headers: { Authorization: auth, Accept: "application/json" },
});
if (!res.ok) {
	console.error(`HTTP ${res.status}`);
	process.exit(1);
}
const body = await res.json();
console.log(body.data.attributes.vulnerability_information);
