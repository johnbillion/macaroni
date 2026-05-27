This is a Tauri and Preact app that displays an inbox for a HackerOne bug bounty program.

## HackerOne API

The app calls the [HackerOne v1 API](https://api.hackerone.com/customer-resources/) from the Rust side using HTTP Basic auth (API username + token, entered via Settings, stored in the OS keychain). Base URL: `https://api.hackerone.com/v1`.

All API access is wrapped behind the `HackerOneApi` trait in `src-tauri/src/hackerone.rs`. The frontend never talks to HackerOne directly — only through Tauri commands in `src-tauri/src/commands.rs`, surfaced to the UI via `src/api/client.ts`.

When the official docs are ambiguous or contradicted by 4xx responses, cross-reference working third-party clients:

- [nu11pointer/hackerone-cli](https://github.com/nu11pointer/hackerone-cli) — Go CLI; good for exact endpoint paths and request bodies.
- [github/hackerone-client](https://github.com/github/hackerone-client) — Ruby wrapper; solid on reports, comments, state changes, and assignees (doesn't cover inboxes).

Permissions gotcha: some POSTs (e.g. assigning a report to an inbox) require *full* permissions on the related resources for the token's group, even when the docs imply Read-only access is sufficient.

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
