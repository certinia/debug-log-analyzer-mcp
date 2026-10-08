# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Common Changelog](https://common-changelog.org/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- apexlog_get_summary: make the categories add up to the whole log. The transaction's own time counts under its category, and a new `platform` row holds the time no event spans
- apexlog_get_summary, apexlog_list_slow_operations, apexlog_execute_anonymous: count the log's duration from its first line, not from the start of the transaction

### Added

- --deny-orgs: refuse anonymous Apex against named orgs, or against an org type with `type:production`. Nothing lifts a deny, and a named org is refused before the server connects to it ([#186])
- apexlog_execute_anonymous: run from a file with `apexFilePath`, reuse saved scripts and save tokens ([#212])
- apexlog_get_summary: report the exceptions a transaction threw, with where and how often, and how many flow elements failed ([#208])

### Fixed

- apexlog_execute_anonymous: stop changing your trace flag's debug level or leaving a 24-hour trace flag on your user ([#207])
- apexlog_execute_anonymous: run the Apex with a warning when the org refuses a trace flag, instead of failing the call ([#207])
- apexlog_get_summary, apexlog_list_slow_operations: time a method that the log never closes up to the end of the log, instead of reporting it too short

## [2.0.1] - 2026-09-11

_Upgrading from 1.x? Every tool is renamed, and `--allowed-orgs` is gone. See [Migrating from 1.x](MIGRATING.md)._

### Added

- apexlog_get_summary: report where the time went by debug log category, with the level each category was captured at, and governor limits by namespace ([#62], [#86], [#108], [#191])
- apexlog_list_slow_operations, apexlog_list_limit_risks: report the debug level each debug log category was captured at, so you can see what the log did not contain ([#102], [#138])
- apexlog_get_summary: report what ended a failed transaction, with its exception message, and which debug log categories the platform truncated ([#97], [#100])
- apexlog_list_slow_operations: group operations by namespace, caller namespace or debug log category, so you can see which package or which kind of work the time went to ([#101], [#126], [#127], [#131], [#138])
- apexlog_list_slow_operations: rank operations by the heap they retain, not only by time ([#99], [#127], [#138])
- apexlog_list_slow_operations: return the query optimiser's plan for each query it ranked ([#120])
- apexlog_execute_anonymous: report progress while it connects, sets the trace flag, runs and writes, and report when the org logged at levels other than the ones asked for ([#65])
- --no-apex-execution: stop `apexlog_execute_anonymous` running Apex while the log analysis tools keep working ([#52])
- server: support the 2026-07-28 protocol revision - clients on the 2025 revisions keep working ([#103])

### Changed

- **Breaking:** all tools: rename with an `apexlog_` prefix - `analyze_apex_log_performance` is now `apexlog_list_slow_operations`. Update your permission lists and prompts; the full mapping is in [Migrating from 1.x](MIGRATING.md) ([#107])
- **Breaking:** apexlog_execute_anonymous: refuse to run Apex against production orgs or orgs whose type cannot be determined, unless you confirm. Clients name the org and show the Apex. Allow with `--allow-production-orgs`. Sandbox, scratch, trial and Developer orgs run unprompted ([#52], [#93])
- apexlog_list_slow_operations: rank every timed operation by self time in one list - queries, DML, callouts and the rest, not only methods, with repeats of the same name folded into one row, where `analyze_apex_log_performance` listed the ten slowest single method calls ([#86], [#97], [#108], [#126])
- apexlog_get_summary: report all thirteen governor limits, zeros included where 1.x reported only those above zero, and state each limit's unit ([#62], [#86], [#108], [#167])
- apexlog_list_limit_risks: report the limits nearest their ceiling as one table, beside the threshold that selected it, in place of the four overlapping sections of `find_performance_bottlenecks` ([#108])
- tool responses: cut them with no fact lost - `apexlog_list_limit_risks` by 58%, and `apexlog_list_slow_operations` ~2.2× smaller, returning fewer rows than asked for where the page would be too large, and stating how many rows matched ([#63], [#97], [#108], [#109], [#120], [#138])
- tool definitions: reduce their token cost on every request by 19%, ~1,529 to ~1,232. Clients can also cache them for an hour ([#87], [#94], [#99], [#101], [#103], [#126], [#127], [#138], [#188], [#189])
- server: start in 55 ms, down from 290 ms, and answer a second question about the same log without parsing it again ([#88], [#165])

### Fixed

- apexlog_list_slow_operations: fix incorrectly reported timings for callouts, which were counted in the calling method's self time ([#97], [#138])
- apexlog_get_summary, apexlog_list_limit_risks: fix understated governor limit usage, which reported the usage the transaction ended on rather than its peak ([#97])
- apexlog_get_summary: fix the understated log size for a log holding non-ASCII characters
- apexlog_execute_anonymous: return the debug log of the run it made, where the newest log for the user could be another process's ([#65])
- apexlog_execute_anonymous: return an absolute log path, and warn when `outputDir` resolves outside every folder the client opened ([#109])
- analysis tools: name the real reason a log file cannot be opened - a permission error used to read as "Log file not found" ([#109])
- apexlog_execute_anonymous: mark it destructive, so clients stop running it unprompted ([#52])

### Removed

- **Breaking:** --allowed-orgs: remove it and its special tokens - the flag is accepted, ignored and warns, and the org's type decides instead ([#52])
- **Breaking:** Node.js: drop Node.js 20 (end of life April 2026) - Node.js 22 is the minimum
- analyze_apex_log_performance: remove the canned recommendations - an agent advises better from the numbers ([#86])

## [2.0.0] - 2026-09-11

_There is no 2.0.0 on npm. Its release failed, and the tag cannot be reused._

## [1.0.0] - 2026-03-20

### Added

- analyze_apex_log_performance: feed in a debug log and see which methods are the slowest, with execution times, SOQL/DML counts and SOSL queries. All durations in milliseconds. Includes log size, debug levels, and thrown exception count.
- get_apex_log_summary: get a debug log summary - total execution time, method count, governor limit usage (all limits with usage > 0), and log issues as structured `{type, summary}` objects.
- find_performance_bottlenecks: detect CPU, database and method performance issues by type, so you know what to focus on. Empty sections are omitted for cleaner responses.
- execute_anonymous: run Apex against any Salesforce org. The debug log is saved to a local file (default: `.apex-log-mcp/` in the project root) and a summary with the file path is returned. Use the file path with the analysis tools for deeper investigation. Specify a target org by alias or username, or use the project default.
  - --allowed-orgs: an org allowlist, disabled by default, that must be explicitly enabled. Supports special tokens: `ALLOW_ALL_ORGS` (permit any org), `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` (resolve from Salesforce CLI config). Aliases in the allowlist are resolved to usernames for matching.
  - debugLevel: set all categories at once (e.g. `"FINEST"`), reset to defaults, or override specific categories like apexCode, database, and nba.
  - outputDir: the directory the debug log is saved to. Defaults to `.apex-log-mcp/` in the project root.

<!-- 2.0.1 -->

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
[#188]: https://github.com/certinia/debug-log-analyzer-mcp/issues/188
[#189]: https://github.com/certinia/debug-log-analyzer-mcp/issues/189
[#191]: https://github.com/certinia/debug-log-analyzer-mcp/issues/191
[#207]: https://github.com/certinia/debug-log-analyzer-mcp/issues/207
[#186]: https://github.com/certinia/debug-log-analyzer-mcp/issues/186
[#208]: https://github.com/certinia/debug-log-analyzer-mcp/issues/208
[#212]: https://github.com/certinia/debug-log-analyzer-mcp/issues/212
