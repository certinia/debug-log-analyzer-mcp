# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Common Changelog](https://common-changelog.org/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_If you are upgrading from 1.x: please see [Migrating from 1.x](MIGRATING.md)._

### Changed

- **Breaking:** prefix every tool `apexlog_` and name it for what comes back, so `analyze_apex_log_performance` is now `apexlog_list_slow_operations`. See [Migrating from 1.x](MIGRATING.md) for the full mapping ([#107])
- **Breaking:** `apexlog_list_slow_operations` ranks every timed operation by self time in one table, folding repeats into one row, in place of its five 1.x fields and its prose `summary`. `topMethods` and `minDuration` are now `limit` and `minSelfMs`, and `groupBy: "none"` ranks each call on its own ([#86], [#108], [#126])
- **Breaking:** every ranked row states the debug log category the platform stamped on the event and the log's own event type — `apexCode,METHOD_ENTRY`, `database,SOQL_EXECUTE_BEGIN` — in place of one `kind` this server invented, and `debugCategory`, `type` and `namespace` all take arrays ([#138])
- **Breaking:** spell every category on the wire as the platform does — `database`, not `DB` — which is the spelling `apexlog_execute_anonymous` already takes as input ([#138])
- **Breaking:** a grouped row's `durationTotalMs`, `soqlCount`, `dmlCount`, `soslCount`, `rowCount` and `thrownCount` state what the transaction takes back if the group never runs, so they are not additive across rows ([#101], [#131])
- **Breaking:** rank a callout under its own `callout` category, taking its wall time out of the calling method's self time, and file duplicate detection and the match engine under `system` ([#97], [#138])
- **Breaking:** `apexlog_get_summary` gains `timeByCategory` and `limitsByNamespace`, so a managed package that spends your CPU time is visible, and reports all thirteen governor limits as flat `{limit, used, max}` rows including the ones at zero. The five `total*` fields and `file` are gone, and three more are renamed for their units ([#62], [#86], [#108])
- **Breaking:** `apexlog_get_summary` states a failed or partial log as facts a caller can act on: `truncated`, `truncatedBy`, `skippedBytes`, `thrownCount` and `fatalErrors` replace `logIssues` and `parsingErrorCount` ([#100])
- **Breaking:** report the peak each governor limit reached, not the usage the transaction ended on, which could sit under a ceiling the run had already breached ([#97])
- **Breaking:** `apexlog_list_limit_risks` returns one `atRisk` table beside the `threshold` that selected it, covering all thirteen limits where its four sections covered six. The `note` and the `analysisType` parameter are gone ([#108])
- **Breaking:** `apexlog_execute_anonymous` is always discoverable, and refuses a production org, or one whose type cannot be read, unless the run is confirmed on request or `--allow-production-orgs` is set ([#52], [#93])
- **Breaking:** `apexlog_execute_anonymous` reports `succeeded` where it reported `success`, and states `outputDirCreated` in place of the prose tip about `.gitignore` ([#109])
- **Breaking:** report a fatal error under its own `fatal` type, summarised as the exception message rather than `FATAL ERROR! cause=…` ([#97])
- **Breaking:** speak the 2026-07-28 protocol revision. Clients on the 2025 revisions keep working ([#103])
- Reduce every tool response with no fact lost: `apexlog_list_limit_risks` by 54%, `apexlog_execute_anonymous` by 30% and `apexlog_list_slow_operations` by 3%. `apexlog_get_summary` costs 24% more, for the two tables it gained ([#62], [#86], [#97], [#108], [#109], [#120], [#138])
- Reduce the standing cost of having the server connected by 9%. `apexlog_list_slow_operations` is the one tool that costs more, by 145%, for what it now selects, ranks and returns ([#87], [#99], [#101], [#103], [#108], [#120], [#126], [#127], [#138])
- `apexlog_execute_anonymous` reports `durationMs` from the log it wrote, so it now agrees with `apexlog_get_summary.durationTotalMs` for the same log ([#65])
- Answer a second question about the same log without parsing it again ([#88])

### Added

- Rank `apexlog_list_slow_operations` rows by the net heap each one's own code retained (`sortBy: "heapSelfNetBytes"`), or fold them by the namespace that called the operation (`groupBy: "callerNamespace"`) or by debug log category (`groupBy: "debugCategory"`). On the 40 logs of a 123-log corpus that allocate, a heap top ten holds a median 6 rows of 10 that the self-time top ten never returns ([#99], [#127], [#138])
- Report the query optimiser's plan for the queries behind the returned rows, as a `queryPlans` table. Above a `relativeCost` of 1 the optimiser will not treat the query as selective ([#120])
- Report the level each debug log category was captured at, as a `capturedAt` table keyed the way the rows are, so the two join ([#102], [#138])
- Report `matchedCount` from `apexlog_list_slow_operations`, so a caller can tell whether the page cap hid anything ([#63])
- Report progress from `apexlog_execute_anonymous` while it connects, sets the trace flag, executes and writes, and `levelsOverridden` when the org logged at levels other than the ones the call asked for ([#65])
- Add `--no-apex-execution`, to stop Apex running at all while the log analysis tools keep working ([#52])
- Let a 2026-07-28 client keep the tool definitions for an hour, and share one cached copy ([#94])

### Removed

- **Breaking:** remove `--allowed-orgs` and its `ALLOW_ALL_ORGS`, `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` tokens. The flag is accepted but ignored, and warns on stderr ([#52])
- **Breaking:** drop support for Node.js 20, which reached end of life in April 2026. Node.js 22 is the minimum

### Fixed

- Rank the operations of a modern log correctly. An event the parser did not know was dropped, and its children reattached to the wrong parent ([#97])
- Bound what `apexlog_list_slow_operations` returns by size, not row count: a `name` is elided past 400 characters and a page stops at 60,000. The worst of 124 real responses falls from 35,520 tokens to 15,511 ([#108])
- Refuse a `limit` or `offset` that is not a whole number at or above zero. `limit: -5` returned the whole ranking where a page was asked for, undetectably ([#108])
- Return the debug log of the run that produced it, where the newest log for the user could be another process's. A run the org returned no log for now says so ([#65])
- Declare `apexlog_execute_anonymous` destructive, so clients stop treating it as safe to run unprompted ([#52])
- Warn when a caller-given `apexlog_execute_anonymous` `outputDir` resolves outside every root the client declared. The log is still written, and the response names where it went ([#109])
- Stop resolving a path against the directory the client spawned the server in: `apexlog_execute_anonymous` returns an absolute `filePath`, and a relative `logFilePath` is refused ([#109])
- Name the real cause when a log file cannot be opened. A permission error, a directory in place of a file, or an exhausted descriptor table were all reported as "Log file not found" ([#109])

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
