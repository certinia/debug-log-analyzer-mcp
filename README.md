# 🛠️ Apex Log MCP Server

[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

Supercharge Salesforce Apex debugging with AI-powered log analysis. Apex Log MCP Server gives AI assistants like Claude and Copilot the ability to identify performance bottlenecks, slow methods, and optimization opportunities in your debug logs - insights that would take hours to find manually.

[Features](#-features "Go to Features") |
[Usage](#-usage "Go to usage guidelines") |
[Tools](#tools "Go to Tools") |
[Configuration](#configuration) |
[Documentation](#-documentation "Go to Documentation") |
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

### Requirements

- Node.js >= 18.0.0
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (for `execute_anonymous` tool)

## Tools

### analyze_apex_log_performance

Identifies the slowest running methods in a debug log with detailed performance metrics.

| Parameter     | Type   | Required | Description                                       |
| ------------- | ------ | -------- | ------------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the .log file                    |
| `topMethods`  | number | No       | Number of slowest methods to return (default: 10) |
| `minDuration` | number | No       | Minimum duration in nanoseconds (default: 0)      |
| `namespace`   | string | No       | Filter by namespace                               |

**Example prompts:**

- "Analyze /path/to/debug.log and show me the 5 slowest methods"
- "Find methods taking more than 100ms in this log"
- "What are the slowest methods in the default namespace?"

### get_apex_log_summary

Provides a high-level summary of log execution including total time, method counts, and governor limit usage.

| Parameter     | Type   | Required | Description                    |
| ------------- | ------ | -------- | ------------------------------ |
| `logFilePath` | string | Yes      | Absolute path to the .log file |

**Example prompts:**

- "Give me a summary of this debug log"
- "How many SOQL queries were executed in this log?"
- "What's the total execution time?"

### find_performance_bottlenecks

Detects and categorizes performance issues by type (CPU, database, or method patterns).

| Parameter      | Type   | Required | Description                                                |
| -------------- | ------ | -------- | ---------------------------------------------------------- |
| `logFilePath`  | string | Yes      | Absolute path to the .log file                             |
| `analysisType` | string | No       | One of: `cpu`, `database`, `methods`, `all` (default: all) |

**Example prompts:**

- "Find database bottlenecks in this log"
- "What are the CPU-intensive operations?"
- "Identify all performance bottlenecks"

### execute_anonymous

Executes anonymous Apex code against any Salesforce org and retrieves the resulting debug log for analysis.

| Parameter   | Type   | Required | Description                                                                                |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `apex`      | string | Yes      | Anonymous Apex code to execute                                                             |
| `targetOrg` | string | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |

**Example prompts:**

- "Execute this Apex and show me the log: `System.debug('Hello');`"
- "Run a query for all Accounts and analyze the performance"
- "Run this Apex against my QA org"

**Note:** Requires Salesforce CLI. Uses the project's default org unless `targetOrg` is specified.

## Configuration

Add to your `claude_desktop_config.json` or `mcp.json`:

```json
{
  "mcpServers": {
    "apex-log-mcp": {
      "command": "npx",
      "args": ["@certinia/apex-log-mcp"]
    }
  }
}
```

## 📚 Documentation

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [Contribute](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md)

### Related Projects

- [Apex Log Analyzer VS Code Extension](https://github.com/certinia/debug-log-analyzer) - Full-featured Apex log analyzer for VS Code
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - SDK used to build this server

## Contributing

We welcome contributions! Please see our [Contributing Guide](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md) for details.

- [Developing](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md) - Set up your development environment
- [Code of Conduct](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CODE_OF_CONDUCT.md) - Community guidelines

### 🏗️ Architecture

- Built with TypeScript and the MCP SDK
- Uses the same `ApexLogParser` as the Apex Log Analyzer VS Code extension
- Runs as a standalone Node.js process
- Communicates via stdio transport

## ❤️ Contributors

Thanks to our amazing contributors!

<p align="center">
  <a href="https://github.com/certinia/debug-log-analyzer-mcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=certinia/debug-log-analyzer-mcp&max=25" />
  </a>
</p>

## 📄 License

<p align="center">
Copyright &copy; Certinia Inc. All rights reserved.
</p>
<p align="center">
  <a href="https://opensource.org/licenses/BSD-3-Clause">
    <img src="https://img.shields.io/badge/License-BSD_3--Clause-blue.svg?style=flat-square"/>
  </a>
</p>
