# Apex Log MCP Server

[![npm version](https://img.shields.io/npm/v/@certinia/apex-log-mcp)](https://www.npmjs.com/package/@certinia/apex-log-mcp)
[![CI](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

**Analyze Salesforce Apex debug logs from your AI assistant. Finds slow methods, governor limit risks, and where a transaction spent its time.**

<p align="center">
  <img src="https://raw.githubusercontent.com/certinia/debug-log-analyzer-mcp/main/docs/images/apex-log-mcp.png" alt="Claude analyzing an Apex debug log for performance bottlenecks and governor limit concerns" width="800" />
</p>

Works with Claude, Copilot, or any MCP client. Instead of scrolling thousands of log lines, ask what's slow and why. Uses the same parser as the [Apex Log Analyzer VS Code extension](https://github.com/certinia/debug-log-analyzer).

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

Requires [Node.js](https://nodejs.org/) 22 or later. Add this to your MCP client config (`claude_desktop_config.json`, VS Code `mcp.json`, and so on):

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

Then ask your assistant to analyze a log. `apexlog_execute_anonymous` also needs an org authenticated with the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli).

## What You Can Do

- "Give me a summary of this debug log"
- "Show me the 5 slowest methods in the default namespace"
- "Are we approaching any governor limits in this transaction?"
- "Run this Apex against my scratch org and analyze the performance"

## Token Cost

### Enabling the tools

Every request carries all four tool definitions, called or not. That is the standing cost of having the server connected. Each figure is the whole definition the client receives — name, title, description, input schema and annotations.

<!-- token-cost-definitions:start -->

| Tool                           | Tokens                              | 1.x        | Change  |
| ------------------------------ | ----------------------------------- | ---------- | ------- |
| `apexlog_list_slow_operations` | ~606                                | ~247       | +145%   |
| `apexlog_execute_anonymous`    | ~421                                | ~844       | -50%    |
| `apexlog_list_limit_risks`     | ~192                                | ~267       | -28%    |
| `apexlog_get_summary`          | ~174                                | ~171       | +2%     |
| **Total**                      | **~1,393** (0.7% of a 200K context) | **~1,529** | **-9%** |

<!-- token-cost-definitions:end -->

### Calling a tool

Every analysis call takes a tool name and a log path, about 15 tokens, so what a call costs is what it returns. Each row answers the same log as 1.x did — the same facts, in a cheaper shape.

Cost does not scale with the log. A response is bounded by its shape — a fixed table of governor limits, a row cap on ranked operations — not by the bytes parsed. Measured against a 40 KB slice of [the Apex Log Analyzer sample log](https://github.com/certinia/debug-log-analyzer/blob/main/sample-app/debug-logs/sample-log.log); on the full 19.7 MB original, `apexlog_get_summary` returns ~374 tokens instead of ~364, and `apexlog_list_limit_risks` returns the same ~35.

<!-- token-cost-answers:start -->

| Tool                           | Response | 1.x  | Change |
| ------------------------------ | -------- | ---- | ------ |
| `apexlog_get_summary`          | ~364     | ~293 | +24%   |
| `apexlog_list_slow_operations` | ~396     | ~408 | -3%    |
| `apexlog_list_limit_risks`     | ~35      | ~84  | -58%   |

<!-- token-cost-answers:end -->

## Tools Reference

All tools return [TOON](https://github.com/toon-format/toon)-encoded data, kept lean by shape rather than by dropping facts:

- **Every governor limit, debug category and operation column is returned, including zeros.** `0` means none, not "not measured".
- **Nested objects are returned as flat tables**, which TOON encodes as one header plus one line per row.
- **Nothing is reported twice**, and no prose restates a number in the table beside it.
- **Only what did not happen is omitted** — fatal errors, lost log content, query plans. Every other field reports its zero.

Durations are milliseconds to 3 decimal places, percentages to 1.

### apexlog_list_slow_operations

Ranks what a log spent its time on by self time — code units, methods, queries, searches, DML, flows and workflows in one table.

Rows are `{debugCategory, type, name, namespace, callCount, durationTotalMs, durationSelfMs, durationSelfMaxMs, selfPercentage, soqlCount, dmlCount, soslCount, rowCount, thrownCount}`, beside the transaction's `durationTotalMs`, the `returnedSelfPercentage` those rows account for, and the `matchedCount` the selection matched before paging. `durationSelfMaxMs` is the slowest single call in a grouped row — read against `durationSelfMs` it tells one bad call from sheer volume — and is absent when each row is already one call.

Both classification columns come from the log. `debugCategory` is what Salesforce stamped on the event, which decided whether it was written at all, and is the spelling `apexlog_execute_anonymous` takes as input. `type` is the event type, which is what the category cannot say: `SOQL_EXECUTE_BEGIN`, `SOSL_EXECUTE_BEGIN` and `DML_BEGIN` all sit under `database`, and `ENTERING_MANAGED_PKG` — the time a package spent where the log shows nothing, often most of a transaction — sits under `apexCode` beside the methods it hides.

`sortBy: "heapSelfNetBytes"` ranks by retained heap instead of time, adding that column and a `returnedHeapPercentage` scalar; both are absent otherwise. The figure is signed `HEAP_ALLOCATE` bytes, so a row that released more than it took reads below zero. Allocations reach the log only at `apexCode` FINER and above, so the `apexCode` row of `capturedAt` says whether a zero is real.

`capturedAt` gives `{debugCategory, level}` for the categories among the returned rows, keyed to join with them.

`queryPlans` gives `{leadingOperationType, relativeCost, cardinality, sObjectCardinality}` for the queries behind the returned rows. A `relativeCost` above 1 means the optimizer will not treat the query as selective. It is absent when the log explained none, which the `database` row of `capturedAt` explains: explain lines are written at `database` FINEST alone. Each plan names its row as `operationRow`, the 1-based line of `operations` — except under a `namespace`, `callerNamespace` or `debugCategory` grouping, where the row is not named after the query, so the plan carries the query text as `name`.

A page is bounded by size as well as by `limit`, so you can get fewer rows than you asked for. Advance `offset` by the rows you got, not by `limit`; `matchedCount` says whether any were hidden.

| Parameter       | Type     | Required | Description                                                                                              |
| --------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `logFilePath`   | string   | Yes      | Absolute path to the Apex debug log file (.log)                                                          |
| `debugCategory` | string[] | No       | Rank only these debug log categories                                                                     |
| `type`          | string[] | No       | Rank only these log event types, e.g. `SOQL_EXECUTE_BEGIN`, `DML_BEGIN`, `METHOD_ENTRY`                  |
| `namespace`     | string[] | No       | Rank only these namespaces                                                                               |
| `minSelfMs`     | number   | No       | Drop operations below this self time (default: 0)                                                        |
| `limit`         | number   | No       | Page size (default: 10); fewer if the page would be too large                                            |
| `offset`        | number   | No       | Ranked rows to skip (default: 0)                                                                         |
| `groupBy`       | string   | No       | Fold repeats into one row by `name` (default), `namespace`, `callerNamespace` or `debugCategory`; `none` ranks each call |
| `sortBy`        | string   | No       | Rank on `durationSelfMs` (default) or `heapSelfNetBytes`                                                 |

### apexlog_get_summary

How long the transaction ran, where the time went, what it consumed, and whether the log is complete. Start here.

All thirteen governor limits are `{limit, used, max}` rows, zeros included. `limitsByNamespace` adds `{namespace, limit, used}` for each limit a namespace consumed — how you see that a managed package spent your CPU time. It names no ceiling, because there is one ceiling per limit for the whole transaction and it is already in `governorLimits`.

`timeByCategory` gives `{debugCategory, operationCount, durationSelfMs, selfPercentage}` for all eleven categories. Since the category decided whether an operation was logged at all, read a zero against `debugLevels` (`{debugCategory, level}`): `database 0` beside `database NONE` means the queries were not logged; beside `database FINEST` it means none ran. Three categories — `dataAccess`, `wave` and `validation` — can only ever be zero, because no timed event carries them.

`truncated` says whether the log is complete; every figure in a partial one is a floor. Where the platform cut it, `truncatedBy` names how (`skipped-lines` for a hole, `max-size` for a missing tail) and `skippedBytes` how much went. Both are absent on a log that merely stops mid-frame. `thrownCount` counts exceptions thrown, zero included. `fatalErrors` gives `{message, frames}` per failure that ended a transaction, with the innermost three frames and a trailing `…` where there were more — it is the only field that says a transaction did not finish, and a fatal error need breach no limit, so nothing else in the response reveals one.

| Parameter     | Type   | Required | Description                                     |
| ------------- | ------ | -------- | ----------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log) |

### apexlog_list_limit_risks

The governor limits nearest their ceiling, worst first.

Rows are `{limit, used, max, usedPercentage}`, beside the `threshold` that selected them — so an empty table reads as "nothing is that far consumed" rather than as a missing answer.

`capturedAt` gives `{debugCategory, level}` for the categories gating the limits returned: `apexProfiling` for the cumulative blocks every limit but heap comes from, `apexCode` for the heap allocations behind `heapSize`.

| Parameter     | Type   | Required | Description                                                      |
| ------------- | ------ | -------- | ---------------------------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log)                  |
| `threshold`   | number | No       | Report a limit once it is this percentage consumed (default: 80) |

### apexlog_execute_anonymous

Runs anonymous Apex against an authenticated org, saves the debug log locally, and returns the path. Pass that path to any analysis tool.

The response also gives the org username (and alias, if set), the org type, and an execution summary. Logs go to `.apex-log-mcp/` by default — add it to your `.gitignore`. Production orgs are gated: see [Production safety](#production-safety).

| Parameter    | Type             | Required | Description                                                                                |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| `apex`       | string           | Yes      | The anonymous Apex to be executed                                                          |
| `targetOrg`  | string           | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `outputDir`  | string           | No       | Directory to save the debug log file. Defaults to `.apex-log-mcp/` in the project root.    |
| `debugLevel` | string \| object | No       | Trace-flag log levels — see below. Omit to keep the current config.                        |

`debugLevel` takes `"default"` to reset every category, a level such as `"FINEST"` to set them all, or an object to override some:

```json
{ "database": "FINEST", "apexCode": "FINE" }
```

Levels are `NONE`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `FINE`, `FINER`, `FINEST`.

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

## Configuration

The [Quick Start](#quick-start) config gives you all four tools. The rest of this section is the production safety policy and how to change it.

### Production safety

`apexlog_execute_anonymous` runs arbitrary Apex, so the server identifies the org before running anything. It asks once per session:

| Org type     | Identified by                     | Behaviour             |
| ------------ | --------------------------------- | --------------------- |
| `sandbox`    | `IsSandbox`, no trial expiry      | Runs                  |
| `scratch`    | `IsSandbox` with a trial expiry   | Runs                  |
| `trial`      | Not a sandbox, has a trial expiry | Runs                  |
| `developer`  | Developer Edition                 | Runs                  |
| `production` | Anything else                     | Confirmation required |
| `unknown`    | The org could not be queried      | Confirmation required |

For a production org the server runs it anyway under `--allow-production-orgs`; otherwise it asks you to confirm, if your client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation), naming the org and showing the Apex; otherwise it refuses, and says both ways to proceed.

An org that cannot be identified is treated as production, so a network or permissions problem can never silently downgrade one.

### Server flags

| Flag                      | Description                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--allow-production-orgs` | Treat production orgs like any other — no confirmation, no refusal. Only set this if production targets are intentional. |
| `--no-apex-execution`     | Refuse every Apex execution. The tool stays visible so agents know it exists. The three analysis tools are unaffected. |

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

## How It Works

- **Runs as a local process.** Your client spawns the server and talks to it over stdio. No network requests, no API keys.
- **Uses the [Apex Log Analyzer](https://github.com/certinia/debug-log-analyzer) parser**, the same one the VS Code extension runs on.
- **Returns structured data** — durations in milliseconds, limits as used/max rows, operations with SOQL and DML counts.
- **Parses a log once, not once per tool.** A summary followed by a deeper look at the same file reuses the parse.

## Documentation

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [MCP Specification](https://modelcontextprotocol.io/)

### Related Projects

- [Apex Log Analyzer VS Code Extension](https://github.com/certinia/debug-log-analyzer) — full Apex log analyzer for VS Code

## Contributing

See the [Contributing Guide](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md).

- [Developing](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md) — set up your development environment
- [Code of Conduct](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CODE_OF_CONDUCT.md) — community guidelines

## Contributors

<p align="center">
  <a href="https://github.com/certinia/debug-log-analyzer-mcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=certinia/debug-log-analyzer-mcp&max=25" alt="Contributors to certinia/debug-log-analyzer-mcp" />
  </a>
</p>

## License

<p align="center">
Copyright &copy; Certinia Inc. All rights reserved.
</p>
<p align="center">
  <a href="https://opensource.org/licenses/BSD-3-Clause">
    <img src="https://img.shields.io/badge/License-BSD_3--Clause-blue.svg?style=flat-square" alt="BSD 3-Clause License"/>
  </a>
</p>
