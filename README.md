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

Every request carries all four tool definitions, called or not - the standing cost of having the server connected. Each figure is the whole definition: name, title, description, input schema and annotations.

<!-- token-cost-definitions:start -->

| Tool                           | Tokens                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| `apexlog_list_slow_operations` | ~530                                                        |
| `apexlog_execute_anonymous`    | ~407                                                        |
| `apexlog_list_limit_risks`     | ~150                                                        |
| `apexlog_get_summary`          | ~145                                                        |
| **Total**                      | **~1,232** (0.6% of a 200K context), **-19% vs 1.x ~1,529** |

<!-- token-cost-definitions:end -->

Only the total compares with 1.x: per tool it would compare different tools, since `apexlog_list_slow_operations` replaced one that took three selection parameters and ranked methods where this one takes eight and ranks every timed event.

### Calling a tool

A call takes a tool name and a log path, about 15 tokens, so a call costs what it returns. Each row answers the same log as 1.x did, with the same facts in a cheaper shape.

Cost does not scale with the log: a response is bounded by its shape - a fixed table of governor limits, a row cap on ranked operations - not by the bytes parsed. Measured against a 40 KB slice of [the Apex Log Analyzer sample log](https://github.com/certinia/debug-log-analyzer/blob/main/sample-app/debug-logs/sample-log.log); on the full 19.7 MB original, `apexlog_get_summary` returns ~374 tokens instead of ~364 and `apexlog_list_limit_risks` the same ~35.

<!-- token-cost-answers:start -->

| Tool                           | Response | 1.x  | Change |
| ------------------------------ | -------- | ---- | ------ |
| `apexlog_get_summary`          | ~364     | ~293 | +24%   |
| `apexlog_list_slow_operations` | ~396     | ~408 | -3%    |
| `apexlog_list_limit_risks`     | ~35      | ~84  | -58%   |

<!-- token-cost-answers:end -->

## Tools Reference

The analysis tools take an absolute path to a `.log` file. All tools return [TOON](https://github.com/toon-format/toon)-encoded flat tables - lean by shape, not by dropping facts. Every limit, category and column is returned, so `0` means none rather than "not measured"; only what did not happen is omitted, which is fatal errors, lost log content and query plans. Nothing is reported twice. Durations are milliseconds to 3 decimal places, percentages to 1.

### apexlog_list_slow_operations

Ranks what a log spent its time on by self time - code units, methods, queries, searches, DML, flows and workflows in one table.

A default response returns:

<!-- shape-apexlog_list_slow_operations:start -->

- `capturedAt` - `{debugCategory, level}`
- `operations` - `{debugCategory, type, name, namespace, callCount, durationTotalMs, durationSelfMs, durationSelfMaxMs, selfPercentage, soqlCount, dmlCount, soslCount, rowCount, thrownCount}`
- `queryPlans` - `{operationRow, leadingOperationType, relativeCost, cardinality, sObjectCardinality}`

<!-- shape-apexlog_list_slow_operations:end -->

beside the transaction's `durationTotalMs`, the `returnedSelfPercentage` those rows account for, and the `matchedCount` matched before paging. `durationSelfMaxMs` is the slowest single call in a grouped row - against `durationSelfMs` it tells one bad call from sheer volume - and is absent when a row is already one call.

Two columns classify each row, both straight from the log. `debugCategory` is what Salesforce stamped on the event, which decided whether it was logged at all, and is the spelling `apexlog_execute_anonymous` takes. `type` is the event type, which the category cannot imply: `SOQL_EXECUTE_BEGIN`, `SOSL_EXECUTE_BEGIN` and `DML_BEGIN` all sit under `database`, and `ENTERING_MANAGED_PKG` - the time a package spent where the log shows nothing, often most of a transaction - sits under `apexCode` beside the methods it hides.

`sortBy: "heapSelfNetBytes"` ranks by retained heap instead of time, adding that column and a `returnedHeapPercentage`; both are absent otherwise. It is signed `HEAP_ALLOCATE` bytes, so a row that released more than it took reads below zero, and allocations are logged only at `apexCode` FINER and above - the `apexCode` row of `capturedAt` says whether a zero is real.

`capturedAt` covers the categories among the returned rows, keyed to join with them.

`queryPlans` is what the optimizer decided about the queries behind those rows: `relativeCost` above 1 means it will not treat the query as selective. It is absent when the log explained none, since explain lines are written at `database` FINEST alone. `operationRow` is the 1-based line of `operations` - except under a `namespace`, `callerNamespace` or `debugCategory` grouping, where the row is not named after the query, so the plan carries the query text as `name`.

<!-- params-apexlog_list_slow_operations:start -->

| Parameter       | Type     | Required | Description |
| --------------- | -------- | -------- | --- |
| `logFilePath`   | string   | Yes      | Absolute path |
| `debugCategory` | string[] | No       | Rank only these debug log categories |
| `type`          | string[] | No       | Rank only these log event types, e.g. SOQL_EXECUTE_BEGIN, DML_BEGIN, METHOD_ENTRY |
| `namespace`     | string[] | No       | Rank only these namespaces |
| `minSelfMs`     | number   | No       | Drop operations below this self time (default: 0), whichever sortBy is used |
| `limit`         | number   | No       | Page size (default: 10); fewer if the page would be too large |
| `offset`        | number   | No       | Ranked rows to skip (default: 0). Advance it by the rows you got, which can be fewer than limit. |
| `groupBy`       | string   | No       | Fold repeats into one row; default name. callerNamespace attributes platform DML to the package that drove it. debugCategory folds a namespace's event types together and so states no type or name. none ranks each call on its own. A grouped durationTotalMs is what the transaction takes back if the group never runs - never sum it across rows. |
| `sortBy`        | string   | No       | Default durationSelfMs. heapSelfNetBytes adds that column. |

<!-- params-apexlog_list_slow_operations:end -->

### apexlog_get_summary

How long the transaction ran, where the time went, what it consumed, and whether the log is complete. Start here.

<!-- shape-apexlog_get_summary:start -->

- `fatalErrors` - `{message, frames}`
- `debugLevels` - `{debugCategory, level}`
- `governorLimits` - `{limit, used, max}`
- `limitsByNamespace` - `{namespace, limit, used}`
- `timeByCategory` - `{debugCategory, operationCount, durationSelfMs, selfPercentage}`

<!-- shape-apexlog_get_summary:end -->

All thirteen governor limits are listed, zeros included. `limitsByNamespace` covers each limit a namespace consumed - how you see a managed package spending your CPU time. It names no ceiling: there is one per limit for the whole transaction, already in `governorLimits`.

`timeByCategory` covers all eleven categories. Since the category decided whether an operation was logged at all, read a zero against `debugLevels`: `database 0` beside `database NONE` means the queries were not logged; beside `database FINEST` it means none ran. Three categories - `dataAccess`, `wave` and `validation` - can only ever be zero, because no timed event carries them.

`truncated` says whether the log is complete; every figure in a partial one is a floor. Where the platform cut it, `truncatedBy` names how (`skipped-lines` for a hole, `max-size` for a missing tail) and `skippedBytes` how much went; both are absent on a log that merely stops mid-frame. `thrownCount` counts exceptions thrown, zero included.

`fatalErrors` appears once per failure that ended a transaction, with the innermost three frames and a trailing `…` where there were more. It is the only field that says a transaction did not finish - a fatal error need breach no limit, so nothing else reveals one.

<!-- params-apexlog_get_summary:start -->

| Parameter     | Type   | Required | Description   |
| ------------- | ------ | -------- | ------------- |
| `logFilePath` | string | Yes      | Absolute path |

<!-- params-apexlog_get_summary:end -->

### apexlog_list_limit_risks

The governor limits nearest their ceiling, worst first.

<!-- shape-apexlog_list_limit_risks:start -->

- `capturedAt` - `{debugCategory, level}`
- `atRisk` - `{limit, used, max, usedPercentage}`

<!-- shape-apexlog_list_limit_risks:end -->

The `threshold` that selected the rows is reported beside them, so an empty table reads as "nothing is that far consumed" rather than as a missing answer.

`capturedAt` covers the categories gating the limits returned: `apexProfiling` for the cumulative blocks every limit but heap comes from, `apexCode` for the heap allocations behind `heapSize`.

<!-- params-apexlog_list_limit_risks:start -->

| Parameter     | Type   | Required | Description |
| ------------- | ------ | -------- | --- |
| `logFilePath` | string | Yes      | Absolute path |
| `threshold`   | number | No       | Report a limit once it is this percentage consumed (default: 80) |

<!-- params-apexlog_list_limit_risks:end -->

### apexlog_execute_anonymous

Runs anonymous Apex against an authenticated org, saves the debug log locally, and returns the path. Pass that path to any analysis tool.

The response also gives the org username (and alias, if set), the org type, and an execution summary. Logs go to `.apex-log-mcp/` by default - add it to your `.gitignore`. Production orgs are gated: see [Production safety](#production-safety).

<!-- params-apexlog_execute_anonymous:start -->

| Parameter    | Type             | Required | Description |
| ------------ | ---------------- | -------- | --- |
| `apex`       | string           | Yes      | The anonymous Apex to be executed |
| `targetOrg`  | string           | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `outputDir`  | string           | No       | Directory to save the debug log file. Defaults to .apex-log-mcp/ in the project root. |
| `debugLevel` | string \| object | No       | Trace flag log levels. "default" restores the defaults; a bare level sets every category to it; an object sets only the categories named and leaves the rest unchanged. Defaults: apexCode, apexProfiling, visualforce, workflow FINE; callout, system, validation DEBUG; database FINEST; nba, wave INFO. |

<!-- params-apexlog_execute_anonymous:end -->

An object `debugLevel` looks like this:

```json
{ "database": "FINEST", "apexCode": "FINE" }
```

Levels are `NONE`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `FINE`, `FINER`, `FINEST`.

**Example prompts:**

- "Execute this Apex and show me the log: `System.debug('Hello');`"
- "Run a query for all Accounts and analyze the performance"
- "Execute this Apex with all debug levels set to FINEST"
- "Run this Apex against my QA org with database logging set to FINEST"

## Configuration

The [Quick Start](#quick-start) config gives you all four tools.

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

For a production org, `--allow-production-orgs` runs it anyway. Otherwise the server asks you to confirm - naming the org, showing the Apex - if your client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation); if not, it refuses and names both ways to proceed.

An org that cannot be identified is treated as production, so a network or permissions problem can never silently downgrade one.

### Server flags

| Flag                      | Description                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--allow-production-orgs` | Treat production orgs like any other - no confirmation, no refusal. Only set this if production targets are intentional. |
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
- **Returns structured data** - durations in milliseconds, limits as used/max rows, operations with SOQL and DML counts.
- **Parses a log once, not once per tool.** A summary followed by a deeper look at the same file reuses the parse.

## Documentation

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [MCP Specification](https://modelcontextprotocol.io/)

### Related Projects

- [Apex Log Analyzer VS Code Extension](https://github.com/certinia/debug-log-analyzer) - full Apex log analyzer for VS Code

## Contributing

See the [Contributing Guide](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md).

- [Developing](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md) - set up your development environment
- [Code of Conduct](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CODE_OF_CONDUCT.md) - community guidelines

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
