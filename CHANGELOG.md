# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Common Changelog](https://common-changelog.org/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_If you are upgrading from 1.x: please see [Migrating from 1.x](README.md#migrating-from-1x)._

### Changed

- **Breaking:** refuse `execute_anonymous` against production orgs, and orgs whose type cannot be read, unless the run is confirmed via [MCP elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) or `--allow-production-orgs` is set ([#52])
- **Breaking:** `analyze_apex_log_performance` now ranks every timed operation by self time, not methods alone: code units, managed packages, methods, system methods, queries, searches, DML, flows and workflows, in one table of `{kind, name, namespace, lineNumber, callCount, durationTotalMs, durationSelfMs, selfPercentage, soqlCount, dmlCount, soslCount, rowCount, thrownCount}` rows. `slowestMethods`, `totalMethods`, `totalExecutionTime`, `topMethodsSelfPercentage` and `recommendations` are gone, replaced by `operations`, `durationTotalMs` and `returnedSelfPercentage`. The `topMethods` and `minDuration` parameters are now `limit` and `minSelfMs`, beside new `kind`, `namespace` and `groupBy` parameters that select and fold the rows ([#108])
- **Breaking:** `find_performance_bottlenecks` now returns one table of the governor limits at risk — `{limit, used, max, usedPercentage}` rows, worst first — beside the `threshold` that selected them. The `cpuBottlenecks`, `databaseBottlenecks`, `methodBottlenecks` and `governorLimitWarnings` sections, the `note`, and the `analysisType` parameter are gone; a new `threshold` parameter sets where a limit becomes worth reporting. All thirteen limits are covered, where the sections covered six, and the response costs 78% less ([#108])
- **Breaking:** drop `file` from `get_apex_log_summary`, and the prose `summary` from `analyze_apex_log_performance` in favour of a scalar share of the runtime ([#86], [#108])
- **Breaking:** report governor limits as a flat `{name, used, limit}` table, and include the limits at zero, so a caller can tell "no DML ran" from "DML was never read" ([#86])
- Make the `execute_anonymous` tool always discoverable, so agents can find it without server flags ([#52])
- Reduce every tool response with no fact lost: `analyze_apex_log_performance` by 33% ([#86], [#108]), `execute_anonymous` by 30% after the first run, and `get_apex_log_summary` by 27% ([#86])
- Reduce the standing cost of having the server connected by 28%: `execute_anonymous` by 49%, `find_performance_bottlenecks` by 25% and `get_apex_log_summary` by 11% ([#87], [#108]). `analyze_apex_log_performance` costs 32% more, for the five parameters that select what it ranks ([#108])
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
- Count entry points in the `totalMethods` reported by `get_apex_log_summary`, which left them out and so reported fewer methods than the log contains ([#88])
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
[#108]: https://github.com/certinia/debug-log-analyzer-mcp/issues/108
[#109]: https://github.com/certinia/debug-log-analyzer-mcp/issues/109
