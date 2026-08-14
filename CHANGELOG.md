# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Common Changelog](https://common-changelog.org/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_If you are upgrading from 1.x: please see [Migrating from 1.x](MIGRATING.md)._

### Changed

- **Breaking:** rename every tool, so the name says which server it belongs to and what comes back: `get_apex_log_summary` is `apexlog_get_summary`, `analyze_apex_log_performance` is `apexlog_list_slow_operations`, `find_performance_bottlenecks` is `apexlog_list_limit_risks`, and `execute_anonymous` is `apexlog_execute_anonymous`. Unprefixed names collide between servers, and a verb that names the work rather than the result cannot be told apart from another tool's ([#107])
- **Breaking:** refuse `apexlog_execute_anonymous` against production orgs, and orgs whose type cannot be read, unless the run is confirmed via [MCP elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) or `--allow-production-orgs` is set ([#52])
- **Breaking:** `apexlog_list_slow_operations` now ranks every timed operation by self time, not methods alone: code units, managed packages, methods, system methods, queries, searches, DML, flows and workflows, in one table of `{kind, name, namespace, lineNumber, callCount, durationTotalMs, durationSelfMs, selfPercentage, soqlCount, dmlCount, soslCount, rowCount, thrownCount}` rows. `slowestMethods`, `totalMethods`, `totalExecutionTime`, `topMethodsSelfPercentage` and `recommendations` are gone, replaced by `operations`, `durationTotalMs` and `returnedSelfPercentage`. The `topMethods` and `minDuration` parameters are now `limit` and `minSelfMs`, beside new `kind`, `namespace` and `groupBy` parameters that select and fold the rows ([#108])
- **Breaking:** `apexlog_list_limit_risks` now returns one table of the governor limits at risk — `{limit, used, max, usedPercentage}` rows, worst first — beside the `threshold` that selected them. The `cpuBottlenecks`, `databaseBottlenecks`, `methodBottlenecks` and `governorLimitWarnings` sections, the `note`, and the `analysisType` parameter are gone; a new `threshold` parameter sets where a limit becomes worth reporting. All thirteen limits are covered, where the sections covered six, and the response costs 78% less ([#108])
- **Breaking:** drop `file` from `apexlog_get_summary`, and the prose `summary` from `apexlog_list_slow_operations` in favour of a scalar share of the runtime ([#86], [#108])
- **Breaking:** `apexlog_get_summary` now reports where the time went and what each namespace consumed. `timeByKind` gives `{kind, logCategory, operationCount, durationSelfMs, selfPercentage}` for every kind of operation, and `limitsByNamespace` gives `{namespace, limit, used}` for each limit a namespace consumed, so a managed package that spends your CPU time is visible. `totalMethods`, `totalSOQLQueries`, `totalDMLOperations`, `totalSOQLRows` and `totalDMLRows` are gone, and searches are covered for the first time. `size`, `totalExecutionTime` and `parsingErrors` are now `fileSizeBytes`, `durationTotalMs` and `parsingErrorCount`, beside a new `truncated`. A `debugLevels` row names its `logCategory`, not its `category`, which is the name `timeByKind` uses for the same fact ([#62], [#108])
- **Breaking:** `apexlog_execute_anonymous` now reports `succeeded` where it reported `success`, and states `outputDirCreated` in place of the prose tip about `.gitignore`, so the response carries facts alone ([#109])
- **Breaking:** report governor limits as a flat `{limit, used, max}` table, and include the limits at zero, so a caller can tell "no DML ran" from "DML was never read" ([#86], [#62])
- Make the `apexlog_execute_anonymous` tool always discoverable, so agents can find it without server flags ([#52])
- Reduce every tool response with no fact lost: `apexlog_list_slow_operations` by 24% ([#86], [#108]) and `apexlog_execute_anonymous` by 30% ([#86], [#109]). `apexlog_get_summary` costs 16% more on a log that uses its limits, for the two tables it gained ([#62])
- **Breaking:** move to the MCP TypeScript SDK v2 packages, so the server speaks the 2026-07-28 protocol revision. Clients on the 2025 revisions keep working through the SDK's compatibility layer ([#103])
- Reduce the standing cost of having the server connected by 26%: `apexlog_execute_anonymous` by 50%, `apexlog_list_limit_risks` by 28% and `apexlog_get_summary` by 5% ([#87], [#108], [#103]). `apexlog_list_slow_operations` costs 46% more, for the five parameters that select what it ranks and for what `groupBy` now states about the grouped row ([#108], [#101], [#126], [#127])
- **Breaking:** `durationTotalMs` on a grouped `apexlog_list_slow_operations` row is now what the transaction takes back if the group never runs. A group holds parents and their children alike, and a parent's total already contains its children's, so the old sum counted the same time more than once — 1.6x the transaction on a real log, 3.1x on the test fixture. Only the calls that ran outside every other call in the group now add their total. The figure is not additive across rows, and `durationSelfMs` is unchanged ([#101])
- **Breaking:** `apexlog_list_slow_operations` now folds repeats into one row by default, where it ranked single calls. A flow element that runs 373 times for 15% of a real transaction was absent from the top ten and is now its second row, and the ten rows returned cover 83% of the self time where they covered 51%. Rows key on kind, namespace and name, so one name in two namespaces stays two rows rather than merging under the first namespace seen. A grouped row adds `durationSelfMaxMs`, the self time of its slowest call — read against `durationSelfMs` it tells one bad call from sheer volume, which need opposite fixes — and `lineNumber` now names that call. Pass `groupBy: "none"` to rank each call on its own ([#126])
- Encode responses with TOON v4. No response changed: v4 removes key folding and path expansion, and this server used neither ([#121])
- Parse a log once rather than once per tool, cached by path, inode, size, modification time and change time, so a summary followed by a deeper tool no longer reads and parses the file again. The parse is dropped after five minutes unused, so a large log is not held for the life of the session ([#88])

### Added

- Add `groupBy: "callerNamespace"` to `apexlog_list_slow_operations`, which folds rows by the namespace that called the operation rather than the one it ran in. DML is pinned to `default` however it was reached, so only the caller says which package drove it: on a real log 4 of the 5 DML rows have a different caller, and they carry 934 of the 944 ms. The two agree on 97% of rows, so this is a grouping and not a column — every response that does not ask for it is unchanged ([#127])
- Add `--allow-production-orgs`, to run against production without confirmation ([#52])
- Add `--no-apex-execution`, to stop Apex running at all while the log analysis tools keep working ([#52])
- Add `pnpm run eval`, which gates every change to a tool response against committed fixtures ([#86])

### Removed

- **Breaking:** remove `--allowed-orgs` and its `ALLOW_ALL_ORGS`, `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` tokens. The flag is accepted but ignored, and warns on stderr ([#52])
- **Breaking:** drop support for Node.js 20, which reached end of life in April 2026. Node.js 22 is the minimum

### Fixed

- Report a grouped `apexlog_list_slow_operations` `durationTotalMs` below the row's own `durationSelfMs`, which is impossible and which no caller can detect. A group counted a member as nested when an operation above it in the log shared the group's key, even where `kind` or `namespace` had excluded that operation from the ranking. Nesting is now tested against the rows being grouped: 114 rows in 111,624 across 124 real logs and every selection ([#101])
- Declare `apexlog_execute_anonymous` destructive, so clients stop treating it as safe to run unprompted ([#52])
- Warn when a caller-given `apexlog_execute_anonymous` `outputDir` resolves outside every root the client declared. The log is still written, and the response names where it went ([#109])
- Close cleanly on `SIGTERM`, so a supervised restart or a container stop no longer kills the server mid-shutdown ([#109])
- Return an absolute `filePath` from `apexlog_execute_anonymous`, so the path it hands back is one the analysis tools accept. A relative `outputDir` now anchors to the project root, the same base the default uses ([#109])
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
[#62]: https://github.com/certinia/debug-log-analyzer-mcp/issues/62
[#86]: https://github.com/certinia/debug-log-analyzer-mcp/issues/86
[#87]: https://github.com/certinia/debug-log-analyzer-mcp/issues/87
[#88]: https://github.com/certinia/debug-log-analyzer-mcp/issues/88
[#107]: https://github.com/certinia/debug-log-analyzer-mcp/issues/107
[#108]: https://github.com/certinia/debug-log-analyzer-mcp/issues/108
[#103]: https://github.com/certinia/debug-log-analyzer-mcp/issues/103
[#109]: https://github.com/certinia/debug-log-analyzer-mcp/issues/109
[#121]: https://github.com/certinia/debug-log-analyzer-mcp/issues/121
[#101]: https://github.com/certinia/debug-log-analyzer-mcp/issues/101
[#126]: https://github.com/certinia/debug-log-analyzer-mcp/issues/126
[#127]: https://github.com/certinia/debug-log-analyzer-mcp/issues/127
