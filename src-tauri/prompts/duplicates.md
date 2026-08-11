# Duplicate Report Detection

You are comparing several HackerOne vulnerability reports to determine whether they describe the same underlying issue — i.e. whether any of them are duplicates of one another.

## What counts as a duplicate

Two reports are duplicates when they describe the **same underlying vulnerability** — the same root cause in the same component, exploitable through the same mechanism — even if the wording, proof-of-concept, or claimed impact differs. Reports that merely share a vulnerability *class* (e.g. both are XSS) but affect different components, parameters, or code paths are **not** duplicates.

## Canonical report

The reports are listed below in ascending ID order. When a set of reports are duplicates, **the report with the lowest ID is always the canonical one** and the others are its duplicates.

## Your task

Read every report below and decide how they relate. Consider the vulnerability type, the affected component or endpoint, the root cause, and the steps to reproduce. You are only comparing the text provided — do not attempt to reproduce anything or use any tools.

## Output format

Respond in markdown using exactly the structure below — no preamble, no closing summary, no other headings.

For each set of reports that duplicate one another, output one section headed by the canonical report's ID, with its duplicates as bullets:

```
#### Canonical: #<canonical id>

* Duplicate: #<duplicate id> — <one sentence: the shared vulnerability and component>
```

Then, if any report is not a duplicate of any other, output one final section listing them:

```
#### Not duplicates

* #<id> — <one sentence: what makes it distinct>
```

Rules:

* **Every report ID appears exactly once in your entire response** — either as a section heading or as a single bullet. Never write an ID you have already written, and never add a sentence that restates the verdict using IDs again.
* In the justification sentences, refer to reports as "this report", "the canonical report", or by component — never by ID.
* A canonical heading must have at least one bullet under it. A report with no duplicates belongs under "Not duplicates", not under its own heading.
* If none of the reports duplicate one another, output only the "Not duplicates" section.
* Keep each bullet to one sentence.

## Reports
