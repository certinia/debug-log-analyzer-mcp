# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Common Changelog](https://common-changelog.org/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Upgrading from 1.x? Every tool is renamed, and `--allowed-orgs` is gone. See [Migrating from 1.x](MIGRATING.md)._

### Added

- Report where the time went by category, and governor limits by namespace, in `apexlog_get_summary` ([#62], [#86], [#108])
- Report the level each debug log category was captured at, in `apexlog_list_slow_operations` and `apexlog_list_limit_risks`, so you can see what the log could not show ([#102], [#138])
- Group operations in `apexlog_list_slow_operations` by name, namespace, caller namespace or debug log category, so you can see whether the time went to one slow call or many small repeats ([#101], [#126], [#127], [#131], [#138])
- Rank operations by the heap they retain in `apexlog_list_slow_operations`, not only by time ([#99], [#127], [#138])
- Return the query optimiser's plan for each query `apexlog_list_slow_operations` ranked ([#120])
- Report progress while `apexlog_execute_anonymous` connects, sets the trace flag, runs and writes, and report when the org logged at levels other than the ones asked for ([#65])
- Add `--no-apex-execution`, which stops `apexlog_execute_anonymous` running Apex while the log analysis tools keep working ([#52])
- Support the 2026-07-28 protocol revision - clients on the 2025 revisions keep working ([#103])

### Changed

- **Breaking:** rename every tool with an `apexlog_` prefix - `analyze_apex_log_performance` is now `apexlog_list_slow_operations`. Update your permission lists and prompts; the full mapping is in [Migrating from 1.x](MIGRATING.md) ([#107])
- **Breaking:** refuse to run Apex from `apexlog_execute_anonymous` for production orgs or orgs whose type cannot be determined, unless you confirm. Clients name the org and show the Apex. Allow with `--allow-production-orgs`. Sandbox, scratch, trial and Developer orgs run unprompted ([#52], [#93])
- Rank every timed operation by self time in one `apexlog_list_slow_operations` list - instead of the five lists and the prose advice of `analyze_apex_log_performance` ([#86], [#97], [#108], [#126])
- Report all thirteen governor limits in `apexlog_get_summary`, zeros included where 1.x reported only those above zero, and state each limit's unit ([#62], [#86], [#108], [#167])
- Report the limits nearest their ceiling in `apexlog_list_limit_risks` as one table, beside the threshold that selected it, in place of the four overlapping sections of `find_performance_bottlenecks` ([#108])
- Report failed logs, partial logs, fatal errors and their exception messages in `apexlog_get_summary` ([#97], [#100])
- Cut tool responses with no fact lost - `apexlog_list_limit_risks` by 58%, and `apexlog_list_slow_operations` ~2.2× smaller, capped by size rather than row count and stating how many rows matched ([#63], [#97], [#108], [#109], [#120], [#138])
- Reduce the tool definitions token cost on every request by 9%, ~1,529 to ~1,393. Clients can also cache them for an hour ([#87], [#94], [#99], [#101], [#103], [#126], [#127], [#138])
- Start the server in 55 ms, down from 290 ms, and answer a second question about the same log without parsing it again ([#88], [#165])

### Fixed

- Fix incorrectly reported timings for callouts in `apexlog_list_slow_operations`, which were counted in the calling method's self time ([#97], [#138])
- Fix understated governor limit usage in `apexlog_get_summary` and `apexlog_list_limit_risks`, which reported the usage the transaction ended on rather than its peak ([#97])
- Return the debug log of the run `apexlog_execute_anonymous` made, where the newest log for the user could be another process's ([#65])
- Return an absolute log path from `apexlog_execute_anonymous`, and warn when `outputDir` resolves outside every folder the client opened ([#109])
- Name the real reason a log file cannot be opened - a permission error used to read as "Log file not found" ([#109])
- Mark `apexlog_execute_anonymous` destructive, so clients stop running it unprompted ([#52])

### Removed

- **Breaking:** remove `--allowed-orgs` and its special tokens - the flag is accepted, ignored and warns, and the org's type decides instead ([#52])
- **Breaking:** drop Node.js 20 (end of life April 2026) - Node.js 22 is the minimum

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
[#167]: https://github.com/certinia/debug-log-analyzer-mcp/issues/167
