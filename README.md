# Macaroni

A read-only desktop inbox for [HackerOne](https://hackerone.com/) bug bounty programs.

Browse reports across your organisations and programs, filter by state, and read full report details — comments, activity, severity, asset, weakness — without leaving the app.

Macaroni rhymes with HackerOne.

## How it works

Macaroni mirrors your program's reports into a local SQLite database and works primarily from that mirror, so filtering and searching are instant rather than waiting on the (slow) HackerOne API. On launch it shows the latest open reports right away, then in the background it backfills every report — open and closed — page by page, and fetches each report's full detail. A progress indicator in the top bar shows what the sync is doing. Each time you open the app it also catches up on anything that changed since the last sync. All searches and filters run against the local database; the app remains **read-only** against HackerOne (it only ever issues `GET` requests).

## Requirements

- macOS
- A HackerOne API token ([create one](https://hackerone.com/users/api_tokens))

## Getting started

1. Launch the app.
2. Enter your HackerOne API username and token. They're stored securely in your macOS keychain.
3. Pick an organisation and program from the sidebar to load the inbox.

You can change your credentials or log out at any time from the settings dialog in the top bar.
