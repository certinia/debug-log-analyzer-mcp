# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Tool responses are smaller, with no loss of fact.** Every field a response used to carry is still there — the saving comes from shape, from not saying the same thing twice, and from not emitting digits nobody reads. Measured on a real 19 MB log: `get_apex_log_summary` ~305 → ~233 tokens, `analyze_apex_log_performance` ~420 → ~294, `find_performance_bottlenecks` ~93 → ~87 (~25% across the three).
  - `get_apex_log_summary` returns `governorLimits` as a flat table of `{name, used, limit}` rows instead of thirteen nested objects. All thirteen limits are still listed, including those at zero — "no DML statements ran" has to be answerable from the response.
  - Durations are rounded to 3 decimal places (ms) and percentages to 1, instead of emitting full float precision.
  - Zero counts, empty tables and every fixed field are still reported. Only lists of things that happened — `logIssues`, `recommendations` — are omitted, and only when nothing happened.
- **`analyze_apex_log_performance` no longer returns `summary`.** The prose paragraph restated figures already present in `slowestMethods`. Its one unique fact — what share of the run the returned methods account for — is now the scalar `topMethodsSelfPercentage`. `recommendations` is kept, reworded to say what to do without repeating the numbers, and is omitted when nothing stands out; it no longer claims performance looks good on a log that blew the CPU limit.
- **`get_apex_log_summary` no longer returns `file`.** The caller supplied the path.
- **`find_performance_bottlenecks` no longer reports a governor limit twice.** SOQL query, DML statement and query row limits detailed by `databaseBottlenecks` are excluded from `governorLimitWarnings`, as CPU time already was.
- **`execute_anonymous` only includes the `.gitignore` tip when it just created the output directory**, rather than on every call.

### Added

- **`pnpm run eval`** — an evaluation suite that drives the built server over stdio against committed log fixtures and asserts, per tool, that realistic user questions are still answerable, that no figure is reported twice, that the payload is under a token budget, and that it matches its golden file. It runs in CI, and is the gate for any change to a response shape. See [`tests/eval/README.md`](tests/eval/README.md).

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
