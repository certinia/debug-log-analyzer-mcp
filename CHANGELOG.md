# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Common Changelog](https://common-changelog.org/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Upgrading from 1.x? Every tool is renamed, and `--allowed-orgs` is gone. See [Migrating from 1.x](MIGRATING.md)._

### Changed

- **Breaking:** rename every tool with an `apexlog_` prefix: `analyze_apex_log_performance` is now `apexlog_list_slow_operations`. Full mapping in [Migrating from 1.x](MIGRATING.md) ([#107])
- **Breaking:** `apexlog_execute_anonymous` refuses a production org, or one it cannot classify, unless you confirm the run or set `--allow-production-orgs` ([#52], [#93])
- `apexlog_list_slow_operations` ranks every timed operation by self time - a callout or a query as well as a method - in place of the five lists and the prose advice of `analyze_apex_log_performance` ([#86], [#97], [#108], [#126])
- `apexlog_get_summary` reports all thirteen governor limits, zeros included, plus time by category and limits by namespace, so a managed package spending your CPU time is visible ([#62], [#86], [#108])
- `apexlog_get_summary` and `apexlog_list_limit_risks` report each governor limit's peak, not the figure the transaction ended on ([#97])
- `apexlog_list_limit_risks` returns one table of the limits nearest their ceiling, covering thirteen where `find_performance_bottlenecks` covered six ([#108])
- `apexlog_get_summary` says whether the log was truncated, by what, and how much it skipped ([#100])
- `apexlog_list_slow_operations` renames its parameters and row fields - `topMethods` is now `limit`, `minDuration` is `minSelfMs`, and `kind` is the platform's debug log category and event type, `database,SOQL_EXECUTE_BEGIN` - and takes a list in every filter ([#86], [#97], [#108], [#138])
- `apexlog_execute_anonymous` renames `success` to `succeeded`, and reports a duration that agrees with `apexlog_get_summary` ([#65], [#109])
- `apexlog_list_slow_operations` caps a response by size, not by row count, so one huge log cannot flood the reply: the biggest of 124 real logs returns 15,511 tokens, down from 35,520 ([#108])
- Cut tool responses with no fact lost - `apexlog_list_limit_risks` by 54%, `apexlog_execute_anonymous` by 30%. `apexlog_get_summary` costs 24% more, for the two tables it gained ([#62], [#86], [#97], [#108], [#109], [#120], [#138])
- Cut the cost of having the server connected by 9%, and let a client cache the tool definitions for an hour, though `apexlog_list_slow_operations` costs 145% more for what it now selects and ranks ([#87], [#94], [#99], [#101], [#103], [#126], [#127], [#138])
- The server starts in 55 ms, down from 290 ms, and reuses the log it parsed, so a second question about the same file skips the parse ([#88], [#165])

### Added

- `apexlog_list_slow_operations` folds repeat calls into one row - by name, by `callerNamespace`, or by debug log category - each row totalling what the transaction saves if the group never runs, so the rows do not add up ([#101], [#126], [#127], [#131], [#138])
- `apexlog_list_slow_operations` sorts by an operation's net heap allocation, not only time (`sortBy: "heapSelfNetBytes"`) ([#99], [#127], [#138])
- `apexlog_list_slow_operations` returns the query optimiser's plan for each query it ranked ([#120])
- `apexlog_list_slow_operations` returns `matchedCount`, so you can tell whether the page hid rows ([#63])
- `apexlog_list_slow_operations` and `apexlog_list_limit_risks` report the level each debug log category was logged at ([#102], [#138])
- `apexlog_execute_anonymous` reports progress, and says when the org logged at levels other than the ones asked for ([#65])
- `--no-apex-execution` stops `apexlog_execute_anonymous` running Apex, while the log analysis tools keep working ([#52])

### Removed

- **Breaking:** remove `--allowed-orgs` and its special tokens. The flag is accepted, ignored and warns, and the org's type decides instead ([#52])
- **Breaking:** drop Node.js 20 (end of life April 2026). Minimum node version is 22

### Fixed

- `apexlog_execute_anonymous` returns the log for the Apex you ran, not the newest log for the user ([#65])
- `apexlog_execute_anonymous` returns an absolute log path, and warns when `outputDir` lands outside the folders the client opened ([#109])
- The log analysis tools name the real reason a log file cannot be opened. A permission error used to read as "Log file not found" ([#109])
- `apexlog_execute_anonymous` is marked destructive, so clients stop running it unprompted ([#52])

## [1.0.0] - 2026-03-20

### Added

- **Performance Analysis** (`analyze_apex_log_performance`) - Feed in a debug log and instantly see which methods are the slowest. See execution times, SOQL/DML counts, and SOSL queries. All durations in milliseconds. Includes log size, debug levels, and thrown exception count.
- **Log Summaries** (`get_apex_log_summary`) - Get a debug log summary. Total execution time, method count, governor limit usage (all limits with usage > 0), and log issues as structured `{type, summary}` objects.
- **Bottleneck Detection** (`find_performance_bottlenecks`) - Detects CPU, database and method performance issues by type so you know exactly what to focus on. Empty sections are omitted for cleaner responses.
- **Anonymous Apex Execution** (`execute_anonymous`) - Run Apex against any Salesforce org. The debug log is saved to a local file (default: `.apex-log-mcp/` in the project root) and a summary with the file path is returned. Use the file path with the analysis tools for deeper investigation. Specify a target org by alias or username, or use the project default.
  - **Org allowlist** (`--allowed-orgs`) - Disabled by default, must be explicitly enabled. Supports special tokens: `ALLOW_ALL_ORGS` (permit any org), `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` (resolve from Salesforce CLI config). Aliases in the allowlist are resolved to usernames for matching.
  - **Debug levels** - Configurable via the `debugLevel` parameter. Set all categories at once (e.g. `"FINEST"`), reset to defaults, or override specific categories like apexCode, database, and nba.
  - **Output directory** - Configurable via the `outputDir` parameter. Defaults to `.apex-log-mcp/` in the project root.

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
[#101]: https://github.com/certinia/debug-log-analyzer-mcp/issues/101
[#126]: https://github.com/certinia/debug-log-analyzer-mcp/issues/126
[#127]: https://github.com/certinia/debug-log-analyzer-mcp/issues/127
[#131]: https://github.com/certinia/debug-log-analyzer-mcp/issues/131
[#102]: https://github.com/certinia/debug-log-analyzer-mcp/issues/102
[#63]: https://github.com/certinia/debug-log-analyzer-mcp/issues/63
[#120]: https://github.com/certinia/debug-log-analyzer-mcp/issues/120
[#138]: https://github.com/certinia/debug-log-analyzer-mcp/issues/138
[#93]: https://github.com/certinia/debug-log-analyzer-mcp/issues/93
[#94]: https://github.com/certinia/debug-log-analyzer-mcp/issues/94
[#65]: https://github.com/certinia/debug-log-analyzer-mcp/issues/65
[#97]: https://github.com/certinia/debug-log-analyzer-mcp/issues/97
[#99]: https://github.com/certinia/debug-log-analyzer-mcp/issues/99
[#100]: https://github.com/certinia/debug-log-analyzer-mcp/issues/100
[#165]: https://github.com/certinia/debug-log-analyzer-mcp/issues/165
