# Security Policy

## Reporting a vulnerability

**Don't report vulnerabilities in public issues, discussions, or PRs.** Instead, open a [private security advisory](https://github.com/certinia/debug-log-analyzer-mcp/security/advisories/new).

Include the affected version and steps to reproduce. We'll acknowledge your report and let you know when a fix ships. Fixes target the latest published version of [`@certinia/apex-log-mcp`](https://www.npmjs.com/package/@certinia/apex-log-mcp).

## Good to know

- The server runs locally, makes no network calls of its own, and needs no API keys.
- `execute_anonymous` runs Apex against real Salesforce orgs. It's disabled unless the `--allowed-orgs` flag is set — treat that allowlist as a security boundary.
