# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-11-20

### Added

- **Performance Analysis** (`analyze_apex_log_performance`) - Feed in a debug log and instantly see which methods are the slowest. See execution times, SOQL/DML counts.
- **Log Summaries** (`get_apex_log_summary`) - Get a debug log summary. Total execution time, method count, governor limit usage.
- **Bottleneck Detection** (`find_performance_bottlenecks`) - Detects CPU, database and method performance issues by type so you know exactly what to focus on.
- **Anonymous Apex Execution** (`execute_anonymous`) - Write Apex, run it, and get the debug log back for analysis.
