# Apex Log MCP Server

[![npm version](https://img.shields.io/npm/v/@certinia/apex-log-mcp)](https://www.npmjs.com/package/@certinia/apex-log-mcp)
[![CI](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

**An MCP server that gives AI assistants tools to analyze Salesforce Apex debug logs for performance bottlenecks, slow methods, and governor limit usage.**

<p align="center">
  <img src="https://raw.githubusercontent.com/certinia/debug-log-analyzer-mcp/main/docs/images/apex-log-mcp.png" alt="Claude analyzing an Apex debug log for performance bottlenecks and governor limit concerns" width="800" />
</p>

Give your AI assistant — Claude, Copilot, or any MCP-compatible client — the ability to parse Apex debug logs and surface the performance insights that matter. Instead of scrolling through thousands of log lines, ask your assistant to find what's slow and why.

[Quick Start](#quick-start) |
[What You Can Do](#what-you-can-do) |
[Tools Reference](#tools-reference) |
[Configuration](#configuration) |
[Requirements](#requirements) |
[How It Works](#how-it-works) |
[Documentation](#documentation) |
[Contributing](#contributing) |
[Contributors](#%EF%B8%8F-contributors "Go to Contributors") |
[License](#-license "Go to License")

## 🚀 Features

- **analyze_apex_log_performance** - Identify the slowest methods in your Apex execution with detailed timing metrics
- **get_apex_log_summary** - Get high-level statistics on execution time, method counts, and governor limits
- **find_performance_bottlenecks** - Find CPU, database, and method performance issues categorized by type
- **execute_anonymous** - Run Apex code against any Salesforce org and immediately analyze the resulting debug log

## 💡 Usage

### Example AI Prompts

- "Analyze this log file for slow methods"
- "What are the performance bottlenecks in this Apex execution?"
- "Summarize the database operations in this debug log"
- "Find methods taking more than 100ms"

## Tools

### analyze_apex_log_performance

Rank methods in an Apex debug log by self-execution time. Returns method names, durations (in ms), SOQL/DML counts, and optimization recommendations. Best for finding which specific methods to optimize.

| Parameter     | Type   | Required | Description                                                       |
| ------------- | ------ | -------- | ----------------------------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log)                   |
| `topMethods`  | number | No       | Number of slowest methods to return (default: 10)                 |
| `minDuration` | number | No       | Minimum duration in milliseconds to include a method (default: 0) |
| `namespace`   | string | No       | Filter methods by namespace                                       |

### get_apex_log_summary

Get a high-level summary of an Apex debug log including total execution time (in ms), method count, SOQL/DML totals, governor limits, and active namespaces. Best for a quick overview before deeper analysis.

| Parameter     | Type   | Required | Description                                     |
| ------------- | ------ | -------- | ----------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log) |

### find_performance_bottlenecks

Check whether an Apex log transaction is approaching governor limits (flags usage above 80%). Analyzes CPU time, SOQL/DML limits, query rows, and method execution patterns by namespace. Best for checking if a transaction is at risk of hitting governor limits.

| Parameter      | Type   | Required | Description                                          |
| -------------- | ------ | -------- | ---------------------------------------------------- |
| `logFilePath`  | string | Yes      | Absolute path to the Apex debug log file (.log)      |
| `analysisType` | string | No       | Type of analysis (default: `all`). See values below. |

**`analysisType` values:**

| Value      | Description                                            |
| ---------- | ------------------------------------------------------ |
| `cpu`      | Checks CPU time governor limit                         |
| `database` | Checks SOQL query, DML statement, and query row limits |
| `methods`  | Groups methods by namespace with duration totals       |
| `all`      | Runs all three analysis types (default)                |

### execute_anonymous

Executes anonymous Apex code against any Salesforce org and retrieves the resulting debug log for analysis.

| Parameter    | Type             | Required | Description                                                                                                                                                                                                                                      |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apex`       | string           | Yes      | The anonymous Apex to be executed                                                                                                                                                                                                                |
| `targetOrg`  | string           | No       | Alias or username of the target Salesforce org. Uses the project default if not specified.                                                                                                                                                       |
| `outputDir`  | string           | No       | Directory to save the debug log file. Defaults to `.apex-log-mcp/` in the project root.                                                                                                                                                          |
| `debugLevel` | string \| object | No       | Controls the trace flag debug levels. Use `"default"` to reset all categories to defaults, a log level string (e.g. `"FINEST"`) to set all categories to that level, or an object to override specific categories. Omit to keep existing config. |

**Default debug levels:**

| Category        | Default Level |
| --------------- | ------------- |
| `apexCode`      | FINE          |
| `apexProfiling` | FINE          |
| `callout`       | DEBUG         |
| `database`      | FINEST        |
| `nba`           | INFO          |
| `system`        | DEBUG         |
| `validation`    | DEBUG         |
| `visualforce`   | FINE          |
| `wave`          | INFO          |
| `workflow`      | FINE          |

Each category accepts a log level: `NONE`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `FINE`, `FINER`, `FINEST`

**Example prompts:**

- "Execute this Apex and show me the log: `System.debug('Hello');`"
- "Run a query for all Accounts and analyze the performance"
- "Execute this Apex with all debug levels set to FINEST"
- "Run this Apex against my QA org with database logging set to FINEST"

**Note:** Requires Salesforce CLI and `--allowed-orgs` to be configured. Uses the project's default org unless `targetOrg` is specified. The response includes the org username and alias (if set).

## Configuration

The [Quick Start](#quick-start) configuration is all you need for log analysis tools. The sections below cover enabling `execute_anonymous`.

### Enabling `execute_anonymous`

The `execute_anonymous` tool is **disabled by default**. To enable it, pass `--allowed-orgs` with a comma-separated list of allowed orgs:

```json
{
  "mcpServers": {
    "apex-log-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@certinia/apex-log-mcp",
        "--allowed-orgs",
        "ALLOW_ALL_ORGS"
      ]
    }
  }
}
```

### Allowed org tokens

| Token                    | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| `ALLOW_ALL_ORGS`         | Permits execution against any authenticated org                          |
| `DEFAULT_TARGET_ORG`     | Resolves the project/global default `target-org` from Salesforce CLI     |
| `DEFAULT_TARGET_DEV_HUB` | Resolves the project/global default `target-dev-hub` from Salesforce CLI |

You can also pass org usernames or aliases directly:

```json
"args": ["-y", "@certinia/apex-log-mcp", "--allowed-orgs", "dev@example.com,my-scratch-org"]
```

## Requirements

- **Node.js** >= 20.19.0
- **[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)** (for `execute_anonymous` only)

## How It Works

This server implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) to expose Apex log analysis as tools that any MCP-compatible AI client can call.

- **Runs as a local process** — your AI client spawns the server and communicates over stdio. No network requests, no API keys.
- **Uses the same parser as the [Apex Log Analyzer VS Code extension](https://github.com/certinia/debug-log-analyzer)** — battle-tested parsing of the Apex debug log format.
- **Returns structured data** — all durations in milliseconds, governor limits as used/limit pairs, methods with SOQL/DML counts — so your AI assistant can reason about the results.

## Documentation

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [MCP Specification](https://modelcontextprotocol.io/)

### Related Projects

- [Apex Log Analyzer VS Code Extension](https://github.com/certinia/debug-log-analyzer) — Full-featured Apex log analyzer for VS Code
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — SDK used to build this server

## Contributing

We welcome contributions! Please see our [Contributing Guide](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md) for details.

- [Developing](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md) — Set up your development environment
- [Code of Conduct](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CODE_OF_CONDUCT.md) — Community guidelines

## Contributors

Thanks to our amazing contributors!

<p align="center">
  <a href="https://github.com/certinia/debug-log-analyzer-mcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=certinia/debug-log-analyzer-mcp&max=25" />
  </a>
</p>

## License

<p align="center">
Copyright &copy; Certinia Inc. All rights reserved.
</p>
<p align="center">
  <a href="https://opensource.org/licenses/BSD-3-Clause">
    <img src="https://img.shields.io/badge/License-BSD_3--Clause-blue.svg?style=flat-square"/>
  </a>
</p>
