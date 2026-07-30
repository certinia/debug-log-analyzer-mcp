# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-07-28

### Changed

- Minimum supported Node.js is now **22**.
- **`execute_anonymous` is always available.** It is no longer hidden from `tools/list` when no orgs are configured, so AI agents can discover it. Whether a given call is permitted is now decided per call.
- **Production orgs are gated per call.** The server identifies the target org type (`sandbox`, `scratch`, `trial`, `developer`, `production`) once per session. Non-production orgs run as before. For a production org the server asks the user to confirm via [MCP elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) if the client supports it, and otherwise refuses with an error explaining how to proceed. An org whose type cannot be determined is treated as production.
- `execute_anonymous` now declares `destructiveHint: true`, since anonymous Apex can modify or delete data.
- The response from `execute_anonymous` includes the detected `orgType`.

### Added

- `--allow-production-orgs` — treat production orgs like any other, skipping both the confirmation prompt and the refusal.
- `--no-apex-execution` — disable Apex execution entirely. The tool remains listed, and says so in its description, but every call is refused without contacting Salesforce. The log analysis tools are unaffected.

### Removed

- **`--allowed-orgs` and its `ALLOW_ALL_ORGS`, `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` tokens.** The flag is still accepted so that existing client configurations continue to start, but it is ignored and logs a deprecation warning to stderr.

### Migration

- `--allowed-orgs <anything>` → remove the flag. Non-production orgs continue to work.
- `--allowed-orgs ALLOW_ALL_ORGS` → remove the flag, and add `--allow-production-orgs` **only** if executing against production is intentional. `ALLOW_ALL_ORGS` no longer implies consent to run against production.
- To restore the 1.x default of never executing Apex, pass `--no-apex-execution`.

## [1.0.0] - 2026-03-20

### Added

- **Performance Analysis** (`analyze_apex_log_performance`) - Feed in a debug log and instantly see which methods are the slowest. See execution times, SOQL/DML counts, and SOSL queries. All durations in milliseconds. Includes log size, debug levels, and thrown exception count.
- **Log Summaries** (`get_apex_log_summary`) - Get a debug log summary. Total execution time, method count, governor limit usage (all limits with usage > 0), and log issues as structured `{type, summary}` objects.
- **Bottleneck Detection** (`find_performance_bottlenecks`) - Detects CPU, database and method performance issues by type so you know exactly what to focus on. Empty sections are omitted for cleaner responses.
- **Anonymous Apex Execution** (`execute_anonymous`) - Run Apex against any Salesforce org. The debug log is saved to a local file (default: `.apex-log-mcp/` in the project root) and a summary with the file path is returned. Use the file path with the analysis tools for deeper investigation. Specify a target org by alias or username, or use the project default.
  - **Org allowlist** (`--allowed-orgs`) — Disabled by default, must be explicitly enabled. Supports special tokens: `ALLOW_ALL_ORGS` (permit any org), `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` (resolve from Salesforce CLI config). Aliases in the allowlist are resolved to usernames for matching.
  - **Debug levels** — Configurable via the `debugLevel` parameter. Set all categories at once (e.g. `"FINEST"`), reset to defaults, or override specific categories like apexCode, database, and nba.
  - **Output directory** — Configurable via the `outputDir` parameter. Defaults to `.apex-log-mcp/` in the project root.
