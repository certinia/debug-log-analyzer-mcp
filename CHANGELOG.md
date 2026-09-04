# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Common Changelog](https://common-changelog.org/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_If you are upgrading from 1.x: please see [Migrating from 1.x](MIGRATING.md)._

### Changed

- **Breaking:** `apexlog_get_summary` states a failed or partial log as facts a caller can act on. `truncated`, `truncatedBy`, `skippedBytes`, `thrownCount` and `fatalErrors` replace `logIssues` and `parsingErrorCount` ([#100])
- **Breaking:** prefix every tool `apexlog_` and name it for what comes back, so `analyze_apex_log_performance` is now `apexlog_list_slow_operations`. See [Migrating from 1.x](MIGRATING.md) for the full mapping ([#107])
- **Breaking:** refuse `apexlog_execute_anonymous` against production orgs, and orgs whose type cannot be read, unless the run is confirmed by MCP elicitation or `--allow-production-orgs` is set ([#52])
- **Breaking:** `apexlog_list_slow_operations` ranks every timed operation by self time, not methods alone, in one `operations` table. Its five 1.x fields are gone, and `topMethods` and `minDuration` are now `limit` and `minSelfMs` ([#108])
- **Breaking:** `apexlog_list_limit_risks` returns one `atRisk` table beside the `threshold` that selected it, covering all thirteen limits where its four sections covered six. The `note` and the `analysisType` parameter are gone ([#108])
- **Breaking:** drop `file` from `apexlog_get_summary`, and the prose `summary` from `apexlog_list_slow_operations` in favour of a scalar share of the runtime ([#86], [#108])
- **Breaking:** `apexlog_get_summary` gains `timeByKind` and `limitsByNamespace`, so a managed package that spends your CPU time is visible. The five `total*` fields are gone, and three more are renamed for their units ([#62], [#108])
- **Breaking:** `apexlog_execute_anonymous` reports `succeeded` where it reported `success`, and states `outputDirCreated` in place of the prose tip about `.gitignore` ([#109])
- **Breaking:** report governor limits as a flat `{limit, used, max}` table, and include the limits at zero, so a caller can tell "no DML ran" from "DML was never read" ([#86], [#62])
- **Breaking:** report the peak each governor limit reached, not the usage the transaction ended on. A counter falls when the frame that spent it exits, so the old figure could sit under a ceiling the run had already breached ([#97])
- **Breaking:** report a fatal error under the type `fatal`, held apart from `error`, and summarise it as the exception message rather than `FATAL ERROR! cause=…` ([#97])
- **Breaking:** move to the MCP TypeScript SDK v2 packages, so the server speaks the 2026-07-28 protocol revision. Clients on the 2025 revisions keep working through the SDK's compatibility layer ([#103])
- **Breaking:** a grouped `apexlog_list_slow_operations` `durationTotalMs` is what the transaction takes back if the group never runs, where the old sum counted nested time once per level of the stack. It is not additive across rows ([#101])
- **Breaking:** `apexlog_list_slow_operations` folds repeats into one row by default, and a grouped row adds `durationSelfMaxMs`, the self time of its slowest call. Pass `groupBy: "none"` to rank each call on its own ([#126])
- **Breaking:** `soqlCount`, `dmlCount`, `soslCount`, `rowCount` and `thrownCount` on a grouped row now count what the group did once, on the same rule `durationTotalMs` follows, and are not additive across rows ([#131])
- **Breaking:** rank a callout as its own `callout` kind, and report the `calloutLevel` that gates it. The published parser times a callout, so its wall time now leaves the calling method's self time ([#97])
- **Breaking:** rank duplicate detection and the match engine as `systemMethod`, where 1.x ranked them `workflow` and `method`. Both are gated by `SYSTEM` ([#97])
- Make the `apexlog_execute_anonymous` tool always discoverable, so agents can find it without server flags ([#52])
- Ask for the production-org confirmation over the 2026-07-28 multi-round-trip flow, where it used to block the call while it asked. The answer is signed, bound to the org and to a digest of the Apex, and authorizes one run ([#93])
- Reduce every tool response with no fact lost: `apexlog_list_slow_operations` by 13%, `apexlog_execute_anonymous` by 30%. `apexlog_get_summary` costs 17% more, for the two tables it gained ([#86], [#108], [#120], [#109], [#62], [#97])
- Reduce the standing cost of having the server connected by 25%. `apexlog_list_slow_operations` is the one tool that costs more, by 53%, for what it now selects and returns ([#87], [#108], [#103], [#101], [#126], [#127], [#120])
- `apexlog_execute_anonymous` reports `durationMs` from the log it wrote, so it now agrees with `apexlog_get_summary.durationTotalMs` for the same log ([#65])
- Parse logs with `@apexdevtools/apex-log-parser` rather than a copy of it kept in this repository, so the parser is versioned, tested and fixed in one place ([#97])
- Encode responses with TOON v4. No response changed: v4 removes key folding and path expansion, and this server used neither ([#121])
- Parse a log once rather than once per tool, cached by path and a stat fingerprint, and dropped five minutes after its last use ([#88])

### Added

- Report the query optimiser's plan for the queries behind the returned rows, as a `queryPlans` table keyed on `operationRow`. Above a `relativeCost` of 1 the optimiser will not treat the query as selective ([#120])
- Report the level each log category was captured at, from `apexlog_list_slow_operations` and `apexlog_list_limit_risks`. A capture level decides what reaches the log, so it qualifies every figure beside it ([#102])
- Report `matchedCount` from `apexlog_list_slow_operations`: the rows the selection matched before `offset`, `limit` or the page budget cut them, so a caller can tell whether the cap hid anything ([#63])
- Add `groupBy: "callerNamespace"` to `apexlog_list_slow_operations`, folding by the namespace that called the operation. DML is pinned to `default` however it was reached, so only the caller says which package drove it ([#127])
- Tell a 2026-07-28 client that `tools/list` keeps for an hour and that a shared cache may hold one copy. Without the hint the SDK states no caching, so every client re-reads the definitions on every turn ([#94])
- Report `levelsOverridden` from `apexlog_execute_anonymous`: true when the org logged at levels other than the ones the call asked for, which a leftover `DEVELOPER_LOG` trace flag causes ([#65])
- Report progress from `apexlog_execute_anonymous` while it connects, sets the trace flag, executes and writes, so a client can say what a long run is doing ([#65])
- Add `--allow-production-orgs`, to run against production without confirmation ([#52])
- Add `--no-apex-execution`, to stop Apex running at all while the log analysis tools keep working ([#52])
- Add `pnpm run eval`, which gates every change to a tool response against committed fixtures ([#86])

### Removed

- **Breaking:** remove `--allowed-orgs` and its `ALLOW_ALL_ORGS`, `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` tokens. The flag is accepted but ignored, and warns on stderr ([#52])
- **Breaking:** drop support for Node.js 20, which reached end of life in April 2026. Node.js 22 is the minimum

### Fixed

- Bound what `apexlog_list_slow_operations` returns by size, not row count: a `name` is elided past 400 characters and a page stops at 60,000, plans included. The worst of 124 real responses falls from 35,520 tokens to 15,511 ([#108], [#120])
- State a query text once in `apexlog_list_slow_operations`. A ranked query row is named after its query, and the plan for it was named the same way, so the same string shipped twice — p90 1,364 tokens across 124 real logs ([#120])
- Refuse a `limit` or `offset` that is not a whole number at or above zero. `limit: -5` reached `slice(0, -5)`, returning the whole ranking where a page was asked for, and no caller could detect it ([#108])
- Rank the operations of a modern log correctly. The vendored parser knew 164 event types against the package's 299, and each unknown one was dropped and its children reattached to the wrong parent ([#97])
- Report `truncated` from `apexlog_get_summary` on a log a section was skipped from, not only on one that ran out mid-transaction. Every figure in a partial log is a floor, not a total ([#124])
- Report a grouped `durationTotalMs` below the row's own `durationSelfMs`, which is impossible. Nesting is now tested against the rows being grouped rather than every operation in the log ([#101])
- Return the debug log of the run that produced it, over the SOAP Apex API and a debug header. The newest `ApexLog` row for the user could be another process's, and a run the org returned no log for now says so ([#65])
- Declare `apexlog_execute_anonymous` destructive, so clients stop treating it as safe to run unprompted ([#52])
- Warn when a caller-given `apexlog_execute_anonymous` `outputDir` resolves outside every root the client declared. The log is still written, and the response names where it went ([#109])
- Close cleanly on `SIGTERM`, so a supervised restart or a container stop no longer kills the server mid-shutdown ([#109])
- Return an absolute `filePath` from `apexlog_execute_anonymous`, so the path it hands back is one the analysis tools accept. A relative `outputDir` anchors to the project root ([#109])
- Refuse a relative `logFilePath` instead of resolving it against the server's working directory, which is where the client spawned the server and not where the caller is ([#109])
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
[#121]: https://github.com/certinia/debug-log-analyzer-mcp/issues/121
[#101]: https://github.com/certinia/debug-log-analyzer-mcp/issues/101
[#126]: https://github.com/certinia/debug-log-analyzer-mcp/issues/126
[#127]: https://github.com/certinia/debug-log-analyzer-mcp/issues/127
[#131]: https://github.com/certinia/debug-log-analyzer-mcp/issues/131
[#124]: https://github.com/certinia/debug-log-analyzer-mcp/issues/124
[#102]: https://github.com/certinia/debug-log-analyzer-mcp/issues/102
[#63]: https://github.com/certinia/debug-log-analyzer-mcp/issues/63
[#120]: https://github.com/certinia/debug-log-analyzer-mcp/issues/120
[#93]: https://github.com/certinia/debug-log-analyzer-mcp/issues/93
[#94]: https://github.com/certinia/debug-log-analyzer-mcp/issues/94
[#65]: https://github.com/certinia/debug-log-analyzer-mcp/issues/65
[#97]: https://github.com/certinia/debug-log-analyzer-mcp/issues/97
[#100]: https://github.com/certinia/debug-log-analyzer-mcp/issues/100
