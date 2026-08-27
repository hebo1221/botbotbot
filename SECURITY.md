# Security policy

BotBotBot is a development alpha. Do not expose its Vite server to a network,
package it as a trusted desktop application, or use it as a credential vault.

## Current boundary

- Bind only to the default loopback address.
- Supply provider keys through the server process environment.
- Never paste credentials into the browser, prompts, issues, logs, or files.
- Pi tools, extensions, remote catalogs, telemetry, and persistence are disabled
  in this public edition.
- No live provider request runs during `npm run verify`.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting or security-advisory feature for
the repository. Do not include a real API key, credential, personal file, or
private transcript in a report. A minimal synthetic reproducer is preferred.

Public issues are appropriate for non-sensitive bugs only.
