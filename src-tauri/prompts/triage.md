# Security Vulnerability Report Triage

## Read the report

Read the vulnerability report below. Focus on the core vulnerability that's being reported rather than the claimed impact. Determine any prerequisites or dependencies in the report, in particular configuration of WordPress settings, user roles, and post content.

## Prepare the local development environment

The local development environment is accessible at http://localhost:8889/. Read docker-compose.yml and README.md for configuration info.

If the environment isn't running, run `npm run env:start`.

Use Playwright MCP in headless mode to access the environment at its URL, read the console, and interact with the web page. Use `browser_run_code` to speed up sequences of interactions where appropriate.

To use WP-CLI you need to include the `@wp` alias in the commands:

`wp @wp <command>`

## Reproduce the reported vulnerability

Autonomously use this development environment to attempt to reproduce the vulnerability in order to determine the validity of the report. Generally presume that the report is valid and attempt to reproduce it as described, however use your initiative if the steps don't work or aren't clear.

* Use WP-CLI commands to check for existing users, settings, and content first to understand the state of the development site.
* Use WP-CLI commands to set up users with different roles, settings, theme configuration, categories, tags, etc.
* When executing PHP with WP-CLI, write the PHP to a file and then use the `eval-file` command rather than `eval`.
* Use Playwright MCP to perform administrative actions such as creating posts in the block editor or using the site editor.
* Create and use a mu-plugin in the `src/wp-content/mu-plugins` directory if it's necessary for custom PHP to be in effect, for example to mimic a plugin using a filter or action.
* Use a direct mysql database connection, the `$wpdb` global in PHP, or WP-CLI to read data from the database as necessary.
* You can write to the database directly only if there isn't an existing API in WordPress, WP-CLI command, or REST API endpoint to achieve the same.
* You can use your standard writing and editing tools to write to files. The `src` directory is mounted to the container.

The vulnerability may require a chain of actions, such as configuring the site, using users with specific roles, setting up options or menus or theme settings, creating content, and then viewing the site, the wp-admin area, the REST API, or XMLRPC. Carefully follow multi-step instructions to reproduce.

Use some initiative if the exact steps to reproduce don't work, aren't clear, or are ambiguous. You are free to use the development environment with little consequence, however you should never commit any changes or use any git or svn commands that write to the repo. It's unlikely you'll need to read the git log, but it's there if you need it.

## Autonomy

* Some reports may not contain enough information to clearly understand the vulnerability being reported, or the report may contain ambiguities. In this case you should proceed with the triage in order to autonomously understand and attempt to reproduce the issue using your knowledge of using and developing on WordPress.
* It may take several attempts to determine whether the report can be reproduced and is therefore valid.

## Determine status

* The report may be inaccurate, for example reports often claim there is an XSS vulnerability but in fact it can only be exploited by Administrator or Editor level users, who have the `unfiltered_html` capability and therefore the report is invalid.
* Decide on an overall validity verdict from exactly one of these four values:
  * `valid` — the vulnerability reproduces as described and the impact is real
  * `partially-valid` — the report identifies a real issue but the severity, exploitability, or impact is overstated or only partly reproducible
  * `invalid` — the report does not reproduce, requires privileges that already permit the action, or is otherwise not a vulnerability
  * `indeterminate` — you could not reach a verdict for environmental reasons (the local development environment failed to start, a required dependency was missing, you ran out of attempts to reproduce a non-deterministic issue, etc.) — use this when the *report itself* may be valid but *you* couldn't confirm

## Output format

Your final response — and only your final response — must be a single JSON object on its own with these exact fields:

* `validity`: one of `"valid"`, `"partially-valid"`, `"invalid"`, or `"indeterminate"`
* `summary`: a markdown-formatted analysis of your findings (what you tested, what you observed, why you reached your verdict)
* `new_files`: an indexed array of absolute file path strings to all of the new files that you wrote to disk

Do not wrap the JSON in code fences. Do not output any text before or after the JSON. Do not save the summary to a file or use any writing tools for it — the caller captures your final message directly and parses it.

Example final response:

`{"validity": "invalid", "summary": "## Overview\n\nThe reported XSS requires Administrator privileges, which already include the `unfiltered_html` capability. ..."}`

## Vulnerability report

Here is the vulnerability report:
