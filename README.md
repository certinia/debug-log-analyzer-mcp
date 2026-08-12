# Apex Log MCP Server

[![npm version](https://img.shields.io/npm/v/@certinia/apex-log-mcp)](https://www.npmjs.com/package/@certinia/apex-log-mcp)
[![CI](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.x-blue)](https://www.typescriptlang.org/)

**A Model Context Protocol (MCP) server that gives AI assistants tools to analyze Salesforce Apex debug logs — surfacing performance bottlenecks, slow methods, and governor limit usage.**

<p align="center">
  <img src="https://raw.githubusercontent.com/certinia/debug-log-analyzer-mcp/main/docs/images/apex-log-mcp.png" alt="Claude analyzing an Apex debug log for performance bottlenecks and governor limit concerns" width="800" />
</p>

Give your AI assistant — Claude, Copilot, or any MCP-compatible client — the ability to parse Apex debug logs and surface the performance insights that matter. Instead of scrolling through thousands of log lines, ask your assistant to find what's slow and why.

Powered by the same powerful log parser as the [Apex Log Analyzer VS Code extension](https://github.com/certinia/debug-log-analyzer) used by thousands of Salesforce developers.

[Quick Start](#quick-start) |
[What You Can Do](#what-you-can-do) |
[Token Cost](#token-cost) |
[Tools Reference](#tools-reference) |
[Configuration](#configuration) |
[How It Works](#how-it-works) |
[Documentation](#documentation) |
[Contributing](#contributing) |
[Contributors](#contributors) |
[License](#license)

## Quick Start

**Requirements:** [Node.js](https://nodejs.org/) 22 or later.

<sub>The `execute_anonymous` tool additionally needs an org authenticated with the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli).</sub>

Add to your MCP client configuration (`claude_desktop_config.json`, VS Code `mcp.json`, etc.):

```json
{
  "mcpServers": {
    "apex-log-mcp": {
      "command": "npx",
      "args": ["-y", "@certinia/apex-log-mcp"]
    }
  }
}
```

That's it. Open a conversation and ask your AI assistant to analyze an Apex debug log.

## What You Can Do

Ask your AI assistant to work with Apex debug logs using natural language:

- "Give me a summary of this debug log"
- "Show me the 5 slowest methods in the default namespace"
- "Are we approaching any governor limits in this transaction?"
- "Run this Apex against my scratch org and analyze the performance"

## Token Cost

### Enabling the tools

Every request carries all four tool definitions, whether or not a tool is called. That is the standing cost of having the server connected, and each figure is the whole definition as the client receives it — name, title, description, input schema and annotations together.

<!-- token-cost-definitions:start -->

| Tool                           | Tokens                              | 1.x        | Change   |
| ------------------------------ | ----------------------------------- | ---------- | -------- |
| `execute_anonymous`            | ~428                                | ~844       | -49%     |
| `analyze_apex_log_performance` | ~326                                | ~247       | +32%     |
| `find_performance_bottlenecks` | ~201                                | ~267       | -25%     |
| `get_apex_log_summary`         | ~153                                | ~171       | -11%     |
| **Total**                      | **~1,108** (0.6% of a 200K context) | **~1,529** | **-28%** |

<!-- token-cost-definitions:end -->

### Calling a tool

The input side is the same for every analysis tool — a tool name and a log file path, about 15 tokens — so what a call costs is what it returns. Each row is one tool answering one of the logs in [`tests/eval/fixtures/`](tests/eval/fixtures), beside what 1.x returned for the same log — the same facts, in a cheaper shape.

<!-- token-cost-answers:start -->

| Tool                           | Log                  | Response | 1.x  | Change |
| ------------------------------ | -------------------- | -------- | ---- | ------ |
| `get_apex_log_summary`         | `governor-heavy.log` | ~220     | ~293 | -25%   |
| `get_apex_log_summary`         | `minimal.log`        | ~174     | ~249 | -30%   |
| `analyze_apex_log_performance` | `governor-heavy.log` | ~275     | ~408 | -33%   |
| `analyze_apex_log_performance` | `minimal.log`        | ~87      | ~190 | -54%   |
| `find_performance_bottlenecks` | `governor-heavy.log` | ~21      | ~84  | -75%   |
| `find_performance_bottlenecks` | `minimal.log`        | ~6       | ~30  | -80%   |

<!-- token-cost-answers:end -->

## Tools Reference

All tools return [TOON](https://github.com/toon-format/toon)-encoded data, kept deliberately lean to save tokens — without dropping anything you might need to ask about. See [Token Cost](#token-cost) for what that is worth in practice.

- **Every governor limit, debug category and operation column is returned**, including the ones at zero. "How many DML statements did this consume?" is answerable from the response, and `0` means none rather than not measured.
- **The leanness comes from shape.** Data that used to be nested objects is returned as flat tables, which TOON encodes as one header plus one line per row.
- **Nothing is reported twice.** No prose summary restates the numbers in the table alongside it, and no figure appears in two places.
- **Durations are rounded** to 3 decimal places (ms) and percentages to 1.
- **Only lists of things that happened are omitted when empty** — log issues. Nothing to report means the key is absent.

### analyze_apex_log_performance

Rank what an Apex debug log spent its time on by self-execution time — code units, managed packages, methods, queries, searches, DML, flows and workflows in one table, each row with its calls, durations (in ms), database counts and rows. Best for finding what to optimize.

Rows are `{kind, name, namespace, lineNumber, callCount, durationTotalMs, durationSelfMs, selfPercentage, soqlCount, dmlCount, soslCount, rowCount, thrownCount}`, beside the transaction's `durationTotalMs` and the `returnedSelfPercentage` the returned rows account for between them.

`kind` is one of `codeUnit`, `managedPackage`, `method`, `systemMethod`, `soql`, `sosl`, `dml`, `flow` or `workflow`. A `managedPackage` row is the time a package spent where the log shows nothing, and is often most of a transaction.

| Parameter     | Type   | Required | Description                                             |
| ------------- | ------ | -------- | ------------------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log)         |
| `kind`        | string | No       | Rank only operations of this kind                       |
| `namespace`   | string | No       | Rank only this namespace                                |
| `minSelfMs`   | number | No       | Drop operations below this self time (default: 0)       |
| `limit`       | number | No       | Rows to return (default: 10)                            |
| `groupBy`     | string | No       | Fold repeats into one row per `name` or per `namespace` |

### get_apex_log_summary

Get a high-level summary of an Apex debug log including total execution time (in ms), method count, SOQL/DML totals, governor limits, debug levels and active namespaces. Best for a quick overview before deeper analysis.

All thirteen governor limits are listed as `{name, used, limit}` rows, at zero included, so you can ask what a transaction consumed and get an answer either way. `debugLevels` names every log category and its level, which is what tells you whether a missing detail was absent from the run or simply never logged.

| Parameter     | Type   | Required | Description                                     |
| ------------- | ------ | -------- | ----------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log) |

### find_performance_bottlenecks

List the governor limits an Apex log transaction has nearly consumed — CPU time, heap, SOQL and SOSL queries, DML statements, and the rows each returned or wrote — worst first, with how much of each was used. Best for checking whether a transaction is at risk of failing on a limit.

Rows are `{limit, used, max, usedPercentage}`. The `threshold` that produced them is reported alongside, so an empty table reads as "nothing is that far consumed" rather than as a missing answer.

| Parameter     | Type   | Required | Description                                                      |
| ------------- | ------ | -------- | ---------------------------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log)                  |
| `threshold`   | number | No       | Report a limit once it is this percentage consumed (default: 80) |

### execute_anonymous

Executes anonymous Apex code against any authenticated Salesforce org. Saves the resulting debug log to a local file and returns a summary with the file path. Use the file path with `get_apex_log_summary`, `analyze_apex_log_performance`, or `find_performance_bottlenecks` for deeper analysis.

| Parameter    | Type             | Required | Description                                                                                                                                                                                                                                      |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apex`       | string           | Yes      | The anonymous Apex to be executed                                                                                                                                                                                                                |
| `targetOrg`  | string           | No       | Alias or username of the target Salesforce org. Uses the project default if not specified.                                                                                                                                                       |
| `outputDir`  | string           | No       | Directory to save the debug log file. Defaults to `.apex-log-mcp/` in the project root.                                                                                                                                                          |
| `debugLevel` | string \| object | No       | Trace-flag log levels — see the options below. Omit to keep the current config. |

**`debugLevel` options** — omit to keep the current config, or pass one of:

- `"default"` — reset every category to its default.
- a log level (e.g. `"FINEST"`) — set every category to that level.
- an object — override specific categories only; the rest keep their defaults:

  ```json
  { "database": "FINEST", "apexCode": "FINE" }
  ```

Valid levels: `NONE`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `FINE`, `FINER`, `FINEST`.

<details>
<summary>📋 <strong>Default debug levels</strong> — used when <code>debugLevel</code> is omitted (click to expand)</summary>
<br />

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

</details>

**Example prompts:**

- "Execute this Apex and show me the log: `System.debug('Hello');`"
- "Run a query for all Accounts and analyze the performance"
- "Execute this Apex with all debug levels set to FINEST"
- "Run this Apex against my QA org with database logging set to FINEST"

> **Note:** Uses the project's default org unless `targetOrg` is specified. Sandbox, scratch, Developer Edition and trial orgs run without prompting; production orgs are gated — see [Production safety](#production-safety). The debug log is saved to a local file (default: `.apex-log-mcp/`) and the response includes the file path, org username (and alias, if set), org type, and execution summary. Add `.apex-log-mcp/` to your `.gitignore` to avoid committing debug logs.

## Configuration

The [Quick Start](#quick-start) configuration is all you need — all four tools are available by default. The sections below cover the production safety policy and how to change it.

### Production safety

`execute_anonymous` runs arbitrary Apex, so before running anything the server identifies what kind of org it is pointed at. It asks the org once per session:

| Org type     | Identified by                                     | Behaviour             |
| ------------ | ------------------------------------------------- | --------------------- |
| `sandbox`    | `IsSandbox`, no trial expiry                      | Runs                  |
| `scratch`    | `IsSandbox` with a trial expiry                   | Runs                  |
| `trial`      | Not a sandbox, has a trial expiry                 | Runs                  |
| `developer`  | Developer Edition                                 | Runs                  |
| `production` | Anything else                                     | Confirmation required |
| `unknown`    | The org could not be queried                      | Confirmation required |

For a production org, the server:

1. Runs it anyway if the server was started with `--allow-production-orgs`.
2. Otherwise asks you to confirm, if your MCP client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation). The prompt names the org and shows the Apex.
3. Otherwise refuses, and the error explains both ways to proceed.

An org that cannot be identified is treated as production, so a network or permissions problem can never silently downgrade a production org.

### Server flags

| Flag                      | Description                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--allow-production-orgs` | Treat production orgs like any other — no confirmation prompt, no refusal. Only set this if production targets are intentional. |
| `--no-apex-execution`     | Disable Apex execution entirely. The tool stays visible so agents know it exists, but every call is refused. The three log analysis tools are unaffected. |

For an analysis-only deployment:

```json
{
  "mcpServers": {
    "apex-log-mcp": {
      "command": "npx",
      "args": ["-y", "@certinia/apex-log-mcp", "--no-apex-execution"]
    }
  }
}
```

### Migrating from 1.x

`--allowed-orgs` was removed in 2.0. It is still accepted so existing configurations keep starting, but it is ignored and logs a deprecation warning — you can delete it.

| 1.x                              | 2.0                                                                      |
| -------------------------------- | ------------------------------------------------------------------------ |
| No flag (tool hidden)            | No flag — the tool is visible and works against non-production orgs      |
| `--allowed-orgs ALLOW_ALL_ORGS`  | No flag. Add `--allow-production-orgs` only if you target production     |
| `--allowed-orgs <org>,<org>`     | No flag. Org-by-org allowlisting is replaced by the org type policy      |

Note that `ALLOW_ALL_ORGS` no longer implies consent to run against production.

## How It Works

This server implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) to expose Apex log analysis as tools that any MCP-compatible AI client can call.

- **Runs as a local process** — your AI client spawns the server and communicates locally. No network requests, no API keys.
- **Uses the same parser as the [Apex Log Analyzer VS Code extension](https://github.com/certinia/debug-log-analyzer)** — battle-tested parsing of the Apex debug log format.
- **Returns structured data** — all durations in milliseconds, governor limits as used/limit pairs, methods with SOQL/DML counts — so your AI assistant can reason about the results.
- **Keeps responses lean** — TOON encoding, no duplicated figures, and zero/empty fields omitted, so more of the context window is left for reasoning.
- **Parses a log once, not once per tool** — a summary followed by a deeper analysis of the same file reuses the parse, so a large log is read and parsed one time.

## Documentation

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [MCP Specification](https://modelcontextprotocol.io/)

### Related Projects

- [Apex Log Analyzer VS Code Extension](https://github.com/certinia/debug-log-analyzer) — Full-featured Apex log analyzer for VS Code

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
