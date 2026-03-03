# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - xxxx-xx-x

### Added

- **Performance Analysis** (`analyze_apex_log_performance`) - Feed in a debug log and instantly see which methods are the slowest. See execution times, SOQL/DML counts.
- **Log Summaries** (`get_apex_log_summary`) - Get a debug log summary. Total execution time, method count, governor limit usage.
- **Bottleneck Detection** (`find_performance_bottlenecks`) - Detects CPU, database and method performance issues by type so you know exactly what to focus on.
- **Anonymous Apex Execution** (`execute_anonymous`) - Run Apex against any Salesforce org and get the debug log back for analysis. Specify a target org by alias or username, or use the project default. Response includes the org alias alongside the username when available.
  - **Debug levels** — Configurable via the `debugLevel` parameter. Set all categories at once (e.g. `"FINEST"`), reset to defaults, or override specific categories like apexCode, database, and nba.
  - **Org allowlist** (`--allowed-orgs`) — Disabled by default, must be explicitly enabled. Supports special tokens: `ALLOW_ALL_ORGS` (permit any org), `DEFAULT_TARGET_ORG` and `DEFAULT_TARGET_DEV_HUB` (resolve from Salesforce CLI config). Aliases in the allowlist are resolved to usernames for matching.
