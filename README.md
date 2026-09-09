# Apex Log MCP Server

[![npm version](https://img.shields.io/npm/v/@certinia/apex-log-mcp)](https://www.npmjs.com/package/@certinia/apex-log-mcp)
[![CI](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/certinia/debug-log-analyzer-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

**MCP Server to Analyze Salesforce Apex debug logs from your AI assistant. Finds slow methods, governor limit risks, and where a transaction spent its time.**

<p align="center">
  <img src="https://raw.githubusercontent.com/certinia/debug-log-analyzer-mcp/main/docs/images/apex-log-mcp.png" alt="Claude analyzing an Apex debug log for performance bottlenecks and governor limit concerns" width="800" />
</p>

Instead of scrolling thousands of log lines, ask what's slow and why. Uses the same parser as the [Apex Log Analyzer VS Code extension](https://github.com/certinia/debug-log-analyzer).

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

## Example Prompts

- "Give me a summary of this debug log"
- "Show me the 5 slowest methods in the default namespace"
- "Are we approaching any governor limits in this transaction?"
- "Run this Apex against my scratch org and analyze the performance"

Keeping the server connected costs ~1,393 tokens, 0.7% of a 200K context. See [Token Cost](#token-cost).

## Tools Reference

Every tool returns one flat table, encoded as [TOON](https://github.com/toon-format/toon). Nothing is repeated, and nothing is dropped to save space.

A `0` means none, not "not measured". Only what did not happen is left out: fatal errors, lost log content, query plans. Durations are in milliseconds to 3 decimal places, percentages to 1.

The server runs as a local process started by your client over stdio, no network calls and no API keys. Each log is parsed once, so follow up questions are faster.

### apexlog_list_slow_operations

Ranks what a log spent its time on by self time - code units, methods, queries, searches, DML, flows and workflows in one table.

A default response returns:

<!-- shape-apexlog_list_slow_operations:start -->

- `capturedAt` - `{debugCategory, level}`
- `operations` - `{debugCategory, type, name, namespace, callCount, durationTotalMs, durationSelfMs, durationSelfMaxMs, selfPercentage, soqlCount, dmlCount, soslCount, rowCount, thrownCount}`
- `queryPlans` - `{operationRow, leadingOperationType, relativeCost, cardinality, sObjectCardinality}`

<!-- shape-apexlog_list_slow_operations:end -->

Each response also gives `durationTotalMs` for the whole transaction, `returnedSelfPercentage` for the share these rows account for, and `matchedCount` for the rows that matched before paging.

`durationSelfMaxMs` is the slowest single call in a grouped row. Read it against `durationSelfMs` to tell one bad call from many small ones. It is absent when the row is already one call.

Two columns say what a row is, both taken straight from the log:

- `debugCategory` - what Salesforce stamped on the event. It decided whether the event was logged at all, and it is the spelling `apexlog_execute_anonymous` takes.
- `type` - the event type. The category cannot imply it: `SOQL_EXECUTE_BEGIN`, `SOSL_EXECUTE_BEGIN` and `DML_BEGIN` all sit under `database`.

Watch for `ENTERING_MANAGED_PKG`. It is time a package spent where the log shows nothing, and it is often most of a transaction.

`sortBy: "heapSelfNetBytes"` ranks by retained heap instead of time, adding that column and `returnedHeapPercentage`. Both are absent otherwise. The figure is signed, so a row that released more than it took reads below zero. Heap is logged only at `apexCode` FINER and above, so check the `apexCode` row of `capturedAt` before trusting a zero.

`capturedAt` gives the level each category in the returned rows was logged at.

`queryPlans` is what the query optimizer decided about the queries behind those rows. A `relativeCost` above 1 means it will not treat the query as selective. Plans are absent when the log explained none, because explain lines need `database` FINEST.

`operationRow` points at a row of `operations`, counting from 1. Under a `namespace`, `callerNamespace` or `debugCategory` grouping a row is not one query, so the plan carries the query text in `name` instead.

<!-- params-apexlog_list_slow_operations:start -->

| Parameter       | Type     | Required | Description |
| --------------- | -------- | -------- | --- |
| `logFilePath`   | string   | Yes      | Absolute path to the Apex debug log file (.log) |
| `debugCategory` | string[] | No       | Rank only these debug log categories |
| `type`          | string[] | No       | Rank only these log event types, e.g. SOQL_EXECUTE_BEGIN, DML_BEGIN, METHOD_ENTRY |
| `namespace`     | string[] | No       | Rank only these namespaces |
| `minSelfMs`     | number   | No       | Drop operations below this self time (default: 0), whichever sortBy is used |
| `limit`         | number   | No       | Page size (default: 10); fewer if the page would be too large |
| `offset`        | number   | No       | Ranked rows to skip (default: 0). Advance it by the rows you got, which can be fewer than limit. |
| `groupBy`       | string   | No       | Fold repeats into one row: by name (default), by namespace, by callerNamespace, which attributes platform DML to the package that drove it, or by debugCategory, which folds a namespace's event types into one row per category and so states no type or name. A grouped durationTotalMs is what the transaction takes back if the group never runs - never sum it across rows. Pass none to rank each call on its own. |
| `sortBy`        | string   | No       | Rank on (default: durationSelfMs). heapSelfNetBytes adds that column. |

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

All thirteen governor limits are listed, zeros included.

`limitsByNamespace` shows what each namespace consumed. This is how you see a managed package spending your CPU time. It has no ceiling column, because a ceiling is per limit for the whole transaction and already sits in `governorLimits`.

`timeByCategory` covers all eleven categories. A category decided whether an operation was logged, so read a zero against `debugLevels`:

- `database 0` beside `database NONE` - the queries were not logged.
- `database 0` beside `database FINEST` - no queries ran.

`dataAccess`, `wave` and `validation` are always zero. No timed event carries them.

`truncated` says whether the log is complete. In a partial log, every figure is a floor. Where the platform cut it, `truncatedBy` says how - `skipped-lines` for a hole, `max-size` for a missing tail - and `skippedBytes` says how much went. Both are absent when a log merely stops mid-frame.

`thrownCount` counts the exceptions thrown, zero included.

`fatalErrors` appears once per failure that ended the transaction, with the innermost three frames and a trailing `…` where there were more. It is the only field that says a transaction did not finish, because a fatal error need not breach any limit.

<!-- params-apexlog_get_summary:start -->

| Parameter     | Type   | Required | Description                                     |
| ------------- | ------ | -------- | ----------------------------------------------- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log) |

<!-- params-apexlog_get_summary:end -->

### apexlog_list_limit_risks

The governor limits nearest their ceiling, worst first.

<!-- shape-apexlog_list_limit_risks:start -->

- `capturedAt` - `{debugCategory, level}`
- `atRisk` - `{limit, used, max, usedPercentage}`

<!-- shape-apexlog_list_limit_risks:end -->

`threshold` is reported beside the rows, so an empty table means nothing reached it rather than that the answer is missing.

`capturedAt` gives the level that gated each returned limit. Every limit but heap comes from `apexProfiling`; `heapSize` comes from `apexCode`.

<!-- params-apexlog_list_limit_risks:start -->

| Parameter     | Type   | Required | Description |
| ------------- | ------ | -------- | --- |
| `logFilePath` | string | Yes      | Absolute path to the Apex debug log file (.log) |
| `threshold`   | number | No       | Report a limit once it is this percentage consumed (default: 80) |

<!-- params-apexlog_list_limit_risks:end -->

### apexlog_execute_anonymous

Runs anonymous Apex against an authenticated org, saves the debug log locally, and returns the path. Pass that path to any analysis tool.

The response also gives the org username, its alias if set, the org type, and a summary of the run. Logs go to `.apex-log-mcp/` by default - add it to your `.gitignore`. Production orgs are gated: see [Production safety](#production-safety).

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

## Token Cost

Every request carries all four tool definitions, whether you call them or not. Each figure below is a whole definition: name, title, description, input schema and annotations.

<!-- token-cost-definitions:start -->

| Tool                           | Tokens                              | 1.x        | Change  |
| ------------------------------ | ----------------------------------- | ---------- | ------- |
| `apexlog_list_slow_operations` | ~606                                | ~247       | +145%   |
| `apexlog_execute_anonymous`    | ~421                                | ~844       | -50%    |
| `apexlog_list_limit_risks`     | ~192                                | ~267       | -28%    |
| `apexlog_get_summary`          | ~174                                | ~171       | +2%     |
| **Total**                      | **~1,393** (0.7% of a 200K context) | **~1,529** | **-9%** |

<!-- token-cost-definitions:end -->

A call itself is about 15 tokens - a tool name and a log path - so what a call costs is what it returns.

Cost does not grow with the log size. The figures below are measured against a 40 KB slice of [the Apex Log Analyzer sample log](https://github.com/certinia/debug-log-analyzer/blob/main/sample-app/debug-logs/sample-log.log). On the full 19.7 MB original, `apexlog_get_summary` returns ~374 tokens instead of ~364, and `apexlog_list_limit_risks` the same ~35.

<!-- token-cost-answers:start -->

| Tool                           | Response | 1.x  | Change |
| ------------------------------ | -------- | ---- | ------ |
| `apexlog_get_summary`          | ~364     | ~293 | +24%   |
| `apexlog_list_slow_operations` | ~396     | ~408 | -3%    |
| `apexlog_list_limit_risks`     | ~35      | ~84  | -58%   |

<!-- token-cost-answers:end -->

## Configuration

The [Quick Start](#quick-start) config gives you all four tools.

### Production safety

`apexlog_execute_anonymous` runs arbitrary Apex, so the server identifies the org before running anything:

| Org type     | Identified by                     | Behaviour             |
| ------------ | --------------------------------- | --------------------- |
| `sandbox`    | `IsSandbox`, no trial expiry      | Runs                  |
| `scratch`    | `IsSandbox` with a trial expiry   | Runs                  |
| `trial`      | Not a sandbox, has a trial expiry | Runs                  |
| `developer`  | Developer Edition                 | Runs                  |
| `production` | Anything else                     | Confirmation required |
| `unknown`    | The org could not be queried      | Confirmation required |

For a production org, `--allow-production-orgs` runs it anyway. Otherwise the server asks you to confirm, naming the org and showing the Apex. That needs a client that supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation); without one the call is refused, and the message names both ways to proceed. Each confirmation authorizes one run.

An org that cannot be identified is treated as production, so a network or permissions problem can never quietly downgrade one.

### Server flags

| Flag                      | Description                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--allow-production-orgs` | Treat production orgs like any other - no confirmation, no refusal. Only set this if production targets are intentional. |
| `--no-apex-execution`     | Refuse every Apex execution. The tool stays visible so agents know it exists. The three analysis tools are unaffected.   |

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

## Documentation

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [Apex Log Analyzer VS Code Extension](https://github.com/certinia/debug-log-analyzer) - the full log analyzer for VS Code
- [MCP Specification](https://modelcontextprotocol.io/)

## Contributing

See the [Contributing Guide](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md), [Developing](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md) to set up your environment, and the [Code of Conduct](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CODE_OF_CONDUCT.md).

<p align="center">
  <a href="https://github.com/certinia/debug-log-analyzer-mcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=certinia/debug-log-analyzer-mcp&max=25" alt="Contributors to certinia/debug-log-analyzer-mcp" />
  </a>
</p>

## License

[BSD 3-Clause](https://opensource.org/licenses/BSD-3-Clause). Copyright &copy; Certinia Inc. All rights reserved.
