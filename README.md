# Macaroni

A read-only desktop inbox for [HackerOne](https://hackerone.com/) bug bounty programs.

Browse reports across your organisations and programs, filter by state, and read full report details — comments, activity, severity, asset, weakness — without leaving the app.

Macaroni rhymes with HackerOne.

## How it works

Macaroni mirrors your program's reports into a local SQLite database and works primarily from that mirror, so filtering and searching are instant rather than waiting on the (slow) HackerOne API. On launch it shows the latest open reports right away, then in the background it backfills every report — open and closed — page by page, and fetches each report's full detail. A progress indicator in the top bar shows what the sync is doing. Each time you open the app it also catches up on anything that changed since the last sync. All searches and filters run against the local database; the app remains **read-only** against HackerOne (it only ever issues `GET` requests).

## Requirements

- macOS 15 or later (Apple Silicon or Intel)
- A HackerOne API token ([create one](https://hackerone.com/users/api_tokens))

## Installing

Download the `.zip` from the [latest release](https://github.com/johnbillion/macaroni/releases), unzip it, and move `Macaroni.app` to your Applications folder.

The app is not currently signed but will be soon. If you don't trust the binary you can build it yourself via `npm install && npm run build`.

## Usage

1. Launch the app.
2. Enter your HackerOne API username and token. They're stored securely in your macOS keychain.
3. Open the settings and select the triage working directory. This should point to a trunk clone of the project source code.

On first startup it'll take a few minutes for Macaroni to sync all the reports. Once they're all in, it only pulls in updates since the last sync. This happens periodically as well as when the app window gets refocused.

The report list can be manually refreshed if necessary via the reload button at the top of the inbox table.

### Filtering

Reports can be filtered and searched from the sidebar. There are no pagination controls, all matching results are always shown.

### AI-powered triage

A report can be triaged by AI from the "Triage" section near the top of the details pane of a report. This kicks off a Claude Code session in the background that will report back once it's made a determination. Be aware that this will spawn foreground Chrome windows because Playwright doesn't respect the instructions to run in headless mode. You can tweak the prompt before running the triage if necessary (eg. to remove cruft from the report or provide more specific instructions).

This can take a few minutes.

The prompt template that gets prepended to the report is editable in the app settings.

Prerequisites:

1. Claude Code installed and available on the cli as `claude`
2. Playwright MCP installed
3. Directory to a local project clone configured in the app settings

### AI-powered duplicate detection

1. Check the checkbox next to several reports.
2. Click the Duplicates tab in the details pane on the right.
3. Click "Check for duplicates".

This will spawn a Claude Code instance in the background to determine and report back on duplicates. You can then double-check and act upon its results.

This is generally a quick operation, perhaps taking up to one minute.

Prerequisites:

1. Claude Code installed and available on the cli as `claude`

### Downloading reports

- You can download multiple reports as a zip of markdown files by checking their checkboxes and clicking the download button at the top of the inbox table.
- You can download a single report or copy its markdown from the details pane.

### UI controls

- Dark/light mode and side/bottom layout arrangement are controlled by the buttons in the top toolbar.
- Inbox table column visibility are controled via the cog at the top right of the table. They're not all shown by default.

## Settings

You can change your credentials or log out at any time from the settings dialog in the top bar.
