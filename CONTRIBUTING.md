This is a Tauri and Preact app that displays an inbox for a HackerOne bug bounty program.

## Linting, formatting, and tests

After you've completed a task, such as fixing a bug or building a new feature, run the linting and testing and fix any issues that are reported.

**Frontend** — run from the repo root:

- `npm run check` — Biome lint, applies fixes in place
- `npm run lint` — Biome lint only, no writes.
- `npm run format` — Biome format, applies fixes in place
- `npx tsc --noEmit` — Type check

**Rust** — run from the `src-tauri` directory:

- `cargo fmt` — Rust format, applies fixes in place
- `cargo clippy --all-targets --fix` — Rust lint, applies fixes in place
- `cargo test` — Unit tests

## HackerOne API

The app calls the [HackerOne v1 API](https://api.hackerone.com/customer-resources/) from the Rust side using HTTP Basic auth (API username + token, entered via Settings, stored in the OS keychain). Base URL: `https://api.hackerone.com/v1`.

All API access is wrapped behind the `HackerOneApi` trait in `src-tauri/src/hackerone.rs`. The frontend never talks to HackerOne directly — only through Tauri commands in `src-tauri/src/commands.rs`, surfaced to the UI via `src/api/client.ts`.

The app is **read-only** against HackerOne: every trait method funnels through the single `get_json` helper, which only issues HTTP `GET` requests. Nothing is created, edited, or deleted on HackerOne. If you add a write (`POST`/`PUT`/`PATCH`/`DELETE`), you're breaking that invariant — update this note and the README accordingly.

### Local database is the primary source

The app is driven primarily by a local SQLite database (`<app_data_dir>/macaroni.db`, `src-tauri/src/local_db.rs`), **not** live API calls. Each report's data lives in exactly one place: a `summary_json` blob (list-level fields) and a `detail_json` blob (activities/attachments). **Nothing is stored twice** — everything the app filters or sorts on (`state`, `severity_rating`, `created_at`, `last_activity_at`, `asset_id`, `assignee_token`) is a `VIRTUAL` generated column derived from `summary_json` via `json_extract`, computed on read and indexed. The only real non-blob columns are the primary key `id`, the `program_handle` (attached at sync time — not part of the report JSON), `detail_fetched_at` (sync bookkeeping), and the triage columns. A `sync_state` row tracks backfill progress and the incremental-update watermark. Upserting a report writes only the blob; the generated columns follow automatically.

The frontend lists reports **only** via the `query_reports` command, which runs filters/search as SQL against this mirror and returns every match (no pagination). Keyword search is a plain case-insensitive `LIKE` substring match over the title and description (fast enough as a scan at this scale — no full-text index to maintain). The background sync engine (`src-tauri/src/sync.rs`, kicked off by `start_report_sync`) is the only thing that calls the `/reports` list endpoint: on launch it fetches the first page of open reports, catches up on anything updated since the watermark (sorted by `-reports.last_activity_at`), backfills all reports oldest-first (`page[size]=100`, HackerOne's max), and hydrates each report's full detail with bounded concurrency. It reports progress via the `sync:status` (Topbar indicator) and `sync:changed` (re-query trigger) events. `get_report` still fetches a single report live (for the selected-report poll) and writes the result through to the DB.

Two behaviours to know about: local keyword search (`LIKE` over title + description) does **not** exactly match the API's opaque `filter[keyword]`; and because the DB can filter locally, the sidebar's `unrated` severity facet (null `severity_rating`) now actually works, unlike against the API.

When the official docs are ambiguous or contradicted by 4xx responses, cross-reference working third-party clients:

- [nu11pointer/hackerone-cli](https://github.com/nu11pointer/hackerone-cli) — Go CLI; good for exact endpoint paths and request bodies.
- [github/hackerone-client](https://github.com/github/hackerone-client) — Ruby wrapper; solid on reports, comments, state changes, and assignees (doesn't cover inboxes).

### Querying the API directly during development

When debugging or exploring API responses it's often useful to hit the HackerOne API directly rather than going through the Rust layer. The user's API credentials are stored in the macOS keychain under service `com.johnbillion.macaroni`, account `default`, as a JSON blob `{"username":"…","token":"…"}` (see [credentials.rs](src-tauri/src/credentials.rs)).

The `scripts/` directory contains small Node helpers (`reports.js`, `inboxes.js`, `attachments.js`, `report-raw.js`, …) that read the credentials straight from the keychain and call the API with HTTP Basic auth. Run them with `node scripts/<name>.js <args>`. Use them — and add new ones — when you need to confirm response shapes or reproduce an edge case without rebuilding the app.

Helper sketch for ad-hoc one-liners:

```js
import { execFileSync } from "node:child_process";
const creds = JSON.parse(execFileSync("security",
  ["find-generic-password","-s","com.johnbillion.macaroni","-a","default","-w"],
  { encoding: "utf8" }).trim());
const auth = `Basic ${Buffer.from(`${creds.username}:${creds.token}`).toString("base64")}`;
const res = await fetch("https://api.hackerone.com/v1/…", {
  headers: { Authorization: auth, Accept: "application/json" },
});
```

Never echo the raw token to the terminal or commit it. The scripts read it into memory and use it only for outgoing requests.

## Important principles

| Principle | Approach |
|---|---|
| **Declarative** | Preact components as pure functions of props and state |
| **Polymorphic** | TypeScript discriminated unions + render maps for revision types, content types, etc. |
| **Reactive** | `useState` / `useContext` with lifted state; `useReducer` for centralized transitions |
| **State-driven** | Single global store via Context + `useReducer`; UI is a projection of state |
| **Testable** | Trait-based Rust services with mock implementations; transport-layer mocking on the frontend |
| **Pure views** | No side effects in components; actions dispatched via context callbacks |
| **Minimal frontend logic** | The frontend renders and captures user intent; business logic lives in Rust |
