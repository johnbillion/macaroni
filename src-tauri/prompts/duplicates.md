# Duplicate Report Detection

You are comparing several HackerOne vulnerability reports to determine whether they describe the same underlying issue — i.e. whether any of them are duplicates of one another.

## What counts as a duplicate

Two reports are duplicates when they describe the **same underlying vulnerability** — the same root cause in the same component, exploitable through the same mechanism — even if the wording, proof-of-concept, or claimed impact differs. Reports that merely share a vulnerability *class* (e.g. both are XSS) but affect different components, parameters, or code paths are **not** duplicates.

## Canonical report

The reports are listed below in ascending ID order. When a set of reports are duplicates, **the report with the lowest ID is always the canonical one** and the others are its duplicates.

## Your task

Read every report below and decide how they relate. Consider the vulnerability type, the affected component or endpoint, the root cause, and the steps to reproduce. You are only comparing the text provided — do not attempt to reproduce anything or use any tools.

## Output format

Respond **briefly** in markdown — a few sentences, not a full report. Your response must:

* State a clear verdict up front: whether the reports are duplicates of one another, and if only some are, which ones.
* When there are duplicates, name the canonical report (the lowest ID) and list the report IDs that duplicate it.
* Give a one- or two-sentence justification referencing the shared (or differing) vulnerability and component.

If the reports are **not** duplicates, say so plainly and briefly explain why they're distinct.

Do not output anything other than this short markdown verdict.

## Reports
