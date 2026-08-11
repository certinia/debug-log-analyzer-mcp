# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Common Changelog](https://common-changelog.org/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_If you are upgrading from 1.x: please see [Migrating from 1.x](README.md#migrating-from-1x)._

### Changed

- **Breaking:** refuse `execute_anonymous` against production orgs, and orgs whose type cannot be read, unless the run is confirmed via [MCP elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) or `--allow-production-orgs` is set ([#52])
- **Breaking:** drop `file` from `get_apex_log_summary`, and the prose `summary` from `analyze_apex_log_performance` in favour of the scalar `topMethodsSelfPercentage` ([#86])
- **Breaking:** report governor limits as a flat `{name, used, limit}` table, and include the limits at zero, so a caller can tell "no DML ran" from "DML was never read" ([#86])
- Make the `execute_anonymous` tool always discoverable, so agents can find it without server flags ([#52])
- Reduce every tool response with no fact lost: `analyze_apex_log_performance` by 33%, `execute_anonymous` by 30% after the first run, `get_apex_log_summary` by 27% and `find_performance_bottlenecks` by 5% ([#86])
- Reduce the standing cost of having the server connected by 31%, with no tool renamed, no parameter removed and no response changed: `execute_anonymous` by 49%, `find_performance_bottlenecks` by 12%, `get_apex_log_summary` by 11% and `analyze_apex_log_performance` by 4% ([#87])
- Parse a log once rather than once per tool, cached by path, inode, size, modification time and change time, so a summary followed by a deeper tool no longer reads and parses the file again. The parse is dropped after five minutes unused, so a large log is not held for the life of the session ([#88])

### Added

- Add `--allow-production-orgs`, to run against production without confirmation ([#52])
- Add `--no-apex-execution`, to stop Apex running at all while the log analysis tools keep working ([#52])
- Add `pnpm run eval`, which gates every change to a tool response against committed fixtures ([#86])

### Removed

- **Breaking:** remove `--allowed-orgs` and its `ALLOW_ALL_ORGS`, `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` tokens. The flag is accepted but ignored, and warns on stderr ([#52])
- **Breaking:** drop support for Node.js 20, which reached end of life in April 2026. Node.js 22 is the minimum

### Fixed

- Declare `execute_anonymous` destructive, so clients stop treating it as safe to run unprompted ([#52])
- Stop `analyze_apex_log_performance` reporting that performance looks good on a log that exhausted the CPU limit ([#86])
- Report the same `totalMethods` from all three analysis tools on an unfiltered call; `get_apex_log_summary` did not count entry points, so it reported fewer methods than the other two ([#88])
- Warn when a caller-given `execute_anonymous` `outputDir` resolves outside every root the client declared. The log is still written, and the response names where it went ([#109])
- Close cleanly on `SIGTERM`, so a supervised restart or a container stop no longer kills the server mid-shutdown ([#109])
- Return an absolute `filePath` from `execute_anonymous`, so the path it hands back is one the analysis tools accept. A relative `outputDir` now anchors to the project root, the same base the default uses ([#109])
- Refuse a relative `logFilePath` instead of resolving it against the server's working directory, which is where the client spawned the server and not where the caller is ([#109])
- Name the real cause when a log file cannot be opened. A permission error, a directory in place of a file, or an exhausted descriptor table were all reported as "Log file not found", sending the caller to look for a file that was there ([#109])

## [1.0.0] - 2026-03-20

### Added

- **Performance Analysis** (`analyze_apex_log_performance`) - Feed in a debug log and instantly see which methods are the slowest. See execution times, SOQL/DML counts, and SOSL queries. All durations in milliseconds. Includes log size, debug levels, and thrown exception count.
- **Log Summaries** (`get_apex_log_summary`) - Get a debug log summary. Total execution time, method count, governor limit usage (all limits with usage > 0), and log issues as structured `{type, summary}` objects.
- **Bottleneck Detection** (`find_performance_bottlenecks`) - Detects CPU, database and method performance issues by type so you know exactly what to focus on. Empty sections are omitted for cleaner responses.
- **Anonymous Apex Execution** (`execute_anonymous`) - Run Apex against any Salesforce org. The debug log is saved to a local file (default: `.apex-log-mcp/` in the project root) and a summary with the file path is returned. Use the file path with the analysis tools for deeper investigation. Specify a target org by alias or username, or use the project default.
  - **Org allowlist** (`--allowed-orgs`) — Disabled by default, must be explicitly enabled. Supports special tokens: `ALLOW_ALL_ORGS` (permit any org), `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` (resolve from Salesforce CLI config). Aliases in the allowlist are resolved to usernames for matching.
  - **Debug levels** — Configurable via the `debugLevel` parameter. Set all categories at once (e.g. `"FINEST"`), reset to defaults, or override specific categories like apexCode, database, and nba.
  - **Output directory** — Configurable via the `outputDir` parameter. Defaults to `.apex-log-mcp/` in the project root.

<!-- Unreleased -->

[#52]: https://github.com/certinia/debug-log-analyzer-mcp/issues/52
[#86]: https://github.com/certinia/debug-log-analyzer-mcp/issues/86
[#87]: https://github.com/certinia/debug-log-analyzer-mcp/issues/87
[#88]: https://github.com/certinia/debug-log-analyzer-mcp/issues/88
[#109]: https://github.com/certinia/debug-log-analyzer-mcp/issues/109
