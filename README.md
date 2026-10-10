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
- "What did my System.debug calls print?"
- "Run this Apex against my scratch org and analyze the performance"

Keeping the server connected costs ~1,232 tokens, 0.6% of a 200K context. See [Token Cost](#token-cost).

## Tools Reference

The analysis tools take an absolute path to a `.log` file.

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
- `governorLimits` - `{limit, used, max}`
- `limitsByNamespace` - `{namespace, limit, used}`
- `categories` - `{debugCategory, level, operationCount, durationSelfMs, selfPercentage}`

<!-- shape-apexlog_get_summary:end -->

All thirteen governor limits are listed, zeros included.

`limitsByNamespace` shows what each namespace consumed. This is how you see a managed package spending your CPU time. It has no ceiling column, because a ceiling is per limit for the whole transaction and already sits in `governorLimits`.

`categories` covers all eleven, each with the level it was captured at, because the level is what a zero means:

- `database,NONE,0` - the queries were not logged.
- `database,FINEST,0` - no queries ran.
- `dataAccess,"",0` - the log's header declared no level for it, which most logs do not.

`dataAccess`, `wave` and `validation` are always zero. No timed event carries them.

A last `unattributed` row holds the time no event spans, such as the time before the transaction starts. With it, the rows add up to the whole log.

`truncated` says whether the log is complete. In a partial log, every figure is a floor. Where the platform cut it, `truncatedBy` says how - `skipped-lines` for a hole, `max-size` for a missing tail - and `skippedBytes` says how much went. Both are absent when a log merely stops mid-frame.

`thrownCount` counts the exceptions thrown, zero included.

`exceptions` appears when something was thrown: `{message, thrownIn, lineNumber, thrownCount}`, one row per exception message, most thrown first. A message is the first line of the exception, cut at 200 characters, so two messages that differ only after that share a row. `thrownIn` and `lineNumber` say where the message was first thrown. `thrownIn` is the nearest method, constructor or code unit that the log recorded. Below `APEX_CODE,FINE` the log records no method, so `thrownIn` can be a code unit while `lineNumber` is a line in a method that it called. A managed package states its line as `EXTERNAL`. The table stops at 20 rows. `exceptionGroupCount` counts the messages, zero included, so a cut table says so. The log does not say whether a throw was caught.

`flowErrorCount` counts the flow elements that failed, zero included. A flow can fail with no exception and no fatal error.

`fatalErrors` appears once per failure that ended the transaction, with the innermost three frames and a trailing `…` where there were more. It is the only field that says a transaction did not finish, because a fatal error need not breach any limit.

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

`threshold` is reported beside the rows, so an empty table means nothing reached it rather than that the answer is missing.

`capturedAt` gives the level that gated each returned limit. Every limit but heap comes from `apexProfiling`; `heapSize` comes from `apexCode`.

<!-- params-apexlog_list_limit_risks:start -->

| Parameter     | Type   | Required | Description |
| ------------- | ------ | -------- | --- |
| `logFilePath` | string | Yes      | Absolute path |
| `threshold`   | number | No       | Report a limit once it is this percentage consumed (default: 80) |

<!-- params-apexlog_list_limit_risks:end -->

### apexlog_search_events

Searches a log's events in log order, for what the other tools rank or total: what the code printed (`USER_DEBUG`), the validation rules, the statements, or every event under one method. Filters combine, and `offset` walks a long log a page at a time.

<!-- shape-apexlog_search_events:start -->

- `capturedAt` - `{debugCategory, level}`
- `events` - `{eventIndex, parentEventIndex, type, debugCategory, namespace, lineNumber, text}`

<!-- shape-apexlog_search_events:end -->

A row says what an event is and where it sits, not what it cost: rank the time with `apexlog_list_slow_operations`. `eventIndex` names an event and `parentEventIndex` the one it sits under, so a row found here can be opened up with `parentEventIndex`. An exit line is a row only where the log lost its entry, and then it is the one record that the method ran.

Text past 400 characters is elided; ask for one event by `eventIndex` to read up to 30,000 characters of it. `contains` searches the text a row shows, before elision. `maxLevel` reads a `USER_DEBUG` line at the level the code logged it at. A page stops early when it would be too large, and `matchedCount` says how many events matched in all. `capturedAt` gives the level of each category `debugCategory` names, or that the matches came from when every `type` named matched or you asked for one event. Otherwise, or when those name no category the header declared, it gives every level the header declared, because a search that found no `USER_DEBUG` on a log at `apexCode` `NONE` means the log did not capture debug output, not that the code printed none.

<!-- params-apexlog_search_events:start -->

| Parameter          | Type     | Required | Description |
| ------------------ | -------- | -------- | --- |
| `logFilePath`      | string   | Yes      | Absolute path |
| `type`             | string[] | No       | Only these log event types, e.g. USER_DEBUG, VALIDATION_RULE |
| `debugCategory`    | string[] | No       | Only these debug log categories |
| `maxLevel`         | string   | No       | Only events a log captured at this level carries |
| `namespace`        | string[] | No       | Only these namespaces |
| `contains`         | string   | No       | Only events whose text holds this, ignoring case |
| `eventIndex`       | number   | No       | Only this event, with more of its text |
| `parentEventIndex` | number   | No       | Only events below this one |
| `limit`            | number   | No       | Page size (default: 50); fewer if the page would be too large |
| `offset`           | number   | No       | Matched rows to skip (default: 0). Advance it by the rows you got, which can be fewer than limit. |

<!-- params-apexlog_search_events:end -->

### apexlog_execute_anonymous

Runs anonymous Apex against an authenticated org, saves the debug log locally, and returns the path. Pass that path to any analysis tool.

Give the Apex inline in `apex`, or the absolute path to a file of it in `apexFilePath`, as `sf apex run --file` takes - for example a script under `scripts/apex/`. Give exactly one. A file outside the roots your client declares is refused, as is anything but a regular file. If your client declares roots this server cannot use - on protocol 2026-07-28, with no answer in 5 seconds, or with none on this machine - a file is refused, and so is a call without `targetOrg`, since the project's default org cannot be found. A path costs a few tokens, where inline Apex is read and then written out again. A production confirmation shows the Apex the file holds, not its path.

The response also gives the org username, its alias if set, the org type, and a summary of the run. Logs go to `.apex-log-mcp/` by default - add it to your `.gitignore`. Production orgs are gated: see [Production safety](#production-safety).

<!-- params-apexlog_execute_anonymous:start -->

| Parameter      | Type             | Required | Description |
| -------------- | ---------------- | -------- | --- |
| `apex`         | string           | No       | The anonymous Apex to execute, or use apexFilePath |
| `apexFilePath` | string           | No       | Absolute path to a file of anonymous Apex |
| `targetOrg`    | string           | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `outputDir`    | string           | No       | Directory to save the debug log file. Defaults to .apex-log-mcp/ in the project root. |
| `debugLevel`   | string \| object | No       | This run's log levels. Omit for your active trace flag's, else the defaults; "traceFlag" requires the flag; "default" forces the defaults; a bare level sets every category; an object sets the named categories over the defaults. Defaults: apexCode, apexProfiling, visualforce, workflow FINE; callout, system, validation DEBUG; database FINEST; nba, wave INFO. |

<!-- params-apexlog_execute_anonymous:end -->

An object `debugLevel` looks like this:

```json
{ "database": "FINEST", "apexCode": "FINE" }
```

Levels are `NONE`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `FINE`, `FINER`, `FINEST`.

Set a `USER_DEBUG` trace flag on your user - in Setup, for example - and every run you start without `debugLevel` logs at its levels; your flag is never changed. `levelsSource` in the response says where a run's levels came from: `traceFlag`, `default` or `request`. A live Developer Console trace flag outranks all three, so the run takes its levels and `levelsSource` is `developerConsole`. `levelsOverridden` says when the log carries levels other than the ones `levelsSource` names.

**Example prompts:**

- "Execute this Apex and show me the log: `System.debug('Hello');`"
- "Run a query for all Accounts and analyze the performance"
- "Execute this Apex with all debug levels set to FINEST"
- "Run this Apex against my QA org with database logging set to FINEST"

### apexlog_list_org_logs

Lists the debug logs stored in an org - a slow UI action, an integration user's request, a Queueable - so an agent can find one it did not run itself. Filters, sorting and paging all run in the org, so a page costs what `limit` asks for, however many logs the org holds. `matchedCount` is how many logs the filters match.

`operation` matches part of the operation in any case, so `aura` finds `/aura`. `succeeded: false` finds the failed logs, and `exceptionMessage` says why each failed. Pass `nextCursor` back as `cursor`, with the same filters and `sortBy`, for the next page; it is absent on the last one. A cursor pages past the 2,000 rows SOQL's `OFFSET` stops at.

<!-- params-apexlog_list_org_logs:start -->

| Parameter          | Type    | Required | Description |
| ------------------ | ------- | -------- | --- |
| `targetOrg`        | string  | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `user`             | string  | No       | Username whose activity was logged |
| `operation`        | string  | No       | Part of the operation, any case, e.g. "aura" for /aura |
| `request`          | string  | No       | e.g. "Api" or "Application" |
| `succeeded`        | boolean | No       | false for failed logs only |
| `startTimeFrom`    | string  | No       | ISO 8601 with a zone, e.g. 2026-10-09T09:00:00Z |
| `startTimeTo`      | string  | No       |  |
| `minFileSizeBytes` | number  | No       |  |
| `sortBy`           | string  | No       | Newest, slowest or largest first (default: startTime) |
| `limit`            | number  | No       | Rows per page (default: 20) |
| `cursor`           | string  | No       | nextCursor from the previous page, with the same filters and sortBy |

<!-- params-apexlog_list_org_logs:end -->

### apexlog_get_org_logs

Downloads logs by `ids`, or the newest `latest` of them - the newest one when you pass neither, as `sf apex get log` does - and returns each saved path, which the analysis tools accept. Up to 25 a call. A log already saved under `outputDir` is not downloaded again, since a stored log never changes; `downloaded` says which were. A log that cannot be downloaded is a row in `failed`, with the cause, and the rest still save. It reports progress as each log saves. Cancelled, it starts no more downloads; those already running finish and are saved.

<!-- params-apexlog_get_org_logs:start -->

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | --- |
| `targetOrg` | string   | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `ids`       | string[] | No       | Log ids, from apexlog_list_org_logs |
| `latest`    | number   | No       | The newest N logs, in place of ids (default: 1) |
| `outputDir` | string   | No       | Directory to save the debug log files. Defaults to .apex-log-mcp/ in the project root. |

<!-- params-apexlog_get_org_logs:end -->

### apexlog_delete_org_logs

Deletes stored logs by `ids`, or every log the filters of `apexlog_list_org_logs` match, to free the org's 1,000 MB of log storage: when it is full, no one in the org can set a trace flag, so `apexlog_execute_anonymous` stops working. A call with no ids and no filter is refused; to delete every log, pass `startTimeTo` set to now - on a production org, at least 5 minutes ago. List with the same filters first to see what goes - a deleted log cannot be restored.

Returns `deletedCount` and `deletedBytes`. One call deletes up to 200 ids, or up to 10,000 logs by filter; `remainingCount` says how many more match, so call again for the rest. `notFoundCount` counts the logs already gone - deleted by an earlier call or by someone else meanwhile - and the ids never in this org; `notFoundIds` names them. Logs that cannot be deleted are in `failed`, one row per cause, with how many and their ids. Both list every id for a delete by id, and the first 5 for a delete by filter. After a request fails, the call sends no more. Against a production org, the call asks first, naming the org, the count, the bytes, and the filters or the first 5 ids. There, a delete by filter needs `startTimeTo` at least 5 minutes ago, so no log filed while you confirm can join what you were shown, even if the org's clock runs behind yours; logs that expire meanwhile only shrink it. A call that matches nothing deletes nothing and asks nothing. It reports progress as each batch of 200 deletes. Cancelled, it starts no more batches; those already sent finish, and the call returns no result.

<!-- params-apexlog_delete_org_logs:start -->

| Parameter          | Type     | Required | Description |
| ------------------ | -------- | -------- | --- |
| `targetOrg`        | string   | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `ids`              | string[] | No       | Log ids, in place of filters |
| `user`             | string   | No       |  |
| `operation`        | string   | No       |  |
| `request`          | string   | No       |  |
| `succeeded`        | boolean  | No       |  |
| `startTimeFrom`    | string   | No       |  |
| `startTimeTo`      | string   | No       |  |
| `minFileSizeBytes` | number   | No       |  |

<!-- params-apexlog_delete_org_logs:end -->

### apexlog_list_trace_flags

Lists the trace flags that have not yet expired - on every entity, or on the one `tracedEntity` names - so an agent can answer "why are there no logs for this user?". An org stores a debug log only for a user a flag traces; a class or trigger flag sets that code's levels in those logs. Each row gives the entity, its type, the log type, the debug level's name, its `levels`, and when the flag starts and expires. At most 200 rows come back, latest to expire first, and `matchedCount` gives how many flags match in all: when it is larger, narrow the list with `tracedEntity`.

<!-- params-apexlog_list_trace_flags:start -->

| Parameter      | Type   | Required | Description |
| -------------- | ------ | -------- | --- |
| `targetOrg`    | string | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `tracedEntity` | string | No       | A username or user id, or a class or trigger name (ns.Name if namespaced) |

<!-- params-apexlog_list_trace_flags:end -->

### apexlog_create_trace_flag

Starts logging a user, so an integration user's requests reach the org's logs, for `apexlog_list_org_logs` to find. A flag on a class or trigger stores no log itself: it sets the levels of that code's work in the logs a user's flag stores. Name a user by username or id, and a namespaced class as `ns.Name`. A user is traced as `USER_DEBUG`; a class or trigger as `CLASS_TRACING`. `debugLevel` takes one level for every category, or an object of categories over the defaults, as `apexlog_execute_anonymous` does, and the flag lives for `durationMinutes`, 30 unless you say, up to 1,439: Salesforce refuses a flag of a full day.

Every transaction a traced user runs while the flag lives is stored, which can fill the org's 1,000 MB of log storage: when it is full, no one can set a flag until `apexlog_delete_org_logs` frees it. When the entity already has a flag of its type that has not ended, the call is refused and names it, with its levels and expiry - a flag is never changed here, so delete it first. Against a production org, the call asks first, naming the entity, the levels and the minutes.

<!-- params-apexlog_create_trace_flag:start -->

| Parameter         | Type             | Required | Description |
| ----------------- | ---------------- | -------- | --- |
| `targetOrg`       | string           | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `tracedEntity`    | string           | Yes      | A username or user id, or a class or trigger name (ns.Name if namespaced) |
| `debugLevel`      | string \| object | No       | A level for every category, or an object setting the named ones over apexlog_execute_anonymous's defaults (default: those defaults) |
| `durationMinutes` | number           | No       | How long it logs (default: 30) |

<!-- params-apexlog_create_trace_flag:end -->

### apexlog_delete_trace_flags

Deletes trace flags by id, to stop logging now: Salesforce refuses an edit that ends a flag early. `notFoundCount` counts the ids that name no flag - already deleted, or never in this org - and `notFoundIds` names them. Flags Salesforce refuses to delete are in `failed`, one row per cause, with how many and their ids. Against a production org, the call asks first, naming each flag. Cancelled, it starts no more deletes; those already sent finish, and the call returns no result.

<!-- params-apexlog_delete_trace_flags:start -->

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | --- |
| `targetOrg` | string   | No       | Alias or username of the target Salesforce org. Uses the project default if not specified. |
| `ids`       | string[] | Yes      | Trace flag ids, from apexlog_list_trace_flags |

<!-- params-apexlog_delete_trace_flags:end -->

## Token Cost

Every request carries all eleven tool definitions, whether you call them or not. Each figure below is a whole definition: name, title, description, input schema and annotations.

<!-- token-cost-definitions:start -->

| Tool                           | Tokens                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `apexlog_list_slow_operations` | ~530                                                         |
| `apexlog_search_events`        | ~453                                                         |
| `apexlog_execute_anonymous`    | ~447                                                         |
| `apexlog_create_trace_flag`    | ~351                                                         |
| `apexlog_list_org_logs`        | ~322                                                         |
| `apexlog_delete_org_logs`      | ~210                                                         |
| `apexlog_get_org_logs`         | ~203                                                         |
| `apexlog_get_summary`          | ~155                                                         |
| `apexlog_list_trace_flags`     | ~152                                                         |
| `apexlog_list_limit_risks`     | ~150                                                         |
| `apexlog_delete_trace_flags`   | ~143                                                         |
| **Total**                      | **~3,116** (1.6% of a 200K context), **+104% vs 1.x ~1,529** |

<!-- token-cost-definitions:end -->

Only the total compares with 1.x: per tool it would compare different tools, since `apexlog_list_slow_operations` replaced one that took three selection parameters and ranked methods where this one takes eight and ranks every timed event. The total is above 1.x because of the six org tools, which reach logs and trace flags 1.x could not, and `apexlog_search_events`, which reaches the events 1.x parsed and dropped; the four tools 1.x also had cost ~1,282.

A call itself is about 15 tokens - a tool name and a log path - so what a call costs is what it returns.

Cost does not grow with the log size. The figures below are measured against a 40 KB slice of [the Apex Log Analyzer sample log](https://github.com/certinia/debug-log-analyzer/blob/main/sample-app/debug-logs/sample-log.log). On the full 19.7 MB original, `apexlog_get_summary` returns ~387 tokens instead of ~335, and `apexlog_list_limit_risks` the same ~35.

<!-- token-cost-answers:start -->

| Tool                           | Response | 1.x  | Change |
| ------------------------------ | -------- | ---- | ------ |
| `apexlog_get_summary`          | ~342     | ~293 | +17%   |
| `apexlog_list_slow_operations` | ~396     | ~408 | -3%    |
| `apexlog_list_limit_risks`     | ~35      | ~84  | -58%   |
| `apexlog_search_events`        | ~972     | -    | -      |

<!-- token-cost-answers:end -->

## Configuration

The [Quick Start](#quick-start) config gives you all eleven tools.

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

For a production org, `--allow-production-orgs` runs it anyway. Otherwise the server asks you to confirm, naming the org and showing all of the Apex with its size. Apex over 10,000 characters is refused rather than cut, so it needs the flag. Confirmation needs a client that supports [elicitation](https://modelcontextprotocol.io/specification/latest/client/elicitation); without one the call is refused, and the message names both ways to proceed. Each confirmation authorizes one run.

An org that cannot be identified is treated as production, so a network or permissions problem can never quietly downgrade one.

### Deny lists

Org type says nothing about whose data an org holds: a customer sandbox runs with no prompt. `--deny-orgs` refuses an org outright.

```json
"args": [
  "-y",
  "@certinia/apex-log-mcp",
  "--deny-orgs",
  "prod-*-org@mycompany.com,acme--*,type:production"
]
```

An entry matches the org id, username, alias or instance URL. `*` is a glob, and the match is anchored and ignores case, so `prod-*@acme.com` denies `prod-eu@acme.com` and not `xprod-eu@acme.com`. A deny on any alias of a username holds, whichever name the agent uses. Every value comes from the local sf files, so the server refuses a named org before it connects to it.

An org id matches in its 15- or 18-char form, whatever its case. An instance URL matches by its host, so `acme--*` denies every sandbox of the `acme` My Domain.

A `type:` entry denies a type from the table above, e.g. `type:sandbox`. `type:production` also denies an org whose type cannot be read, because the server treats that org as production. The server contacts the org before it refuses on type: it connects, and it queries the org type. No Apex runs and no record is written. A `type:` entry that names no org type stops the server.

Nothing lifts a deny - not `--allow-production-orgs`, not a confirmation. The refusal names what matched.

A deny covers every org tool, listing and downloading logs as well as running Apex, since a log holds the org's data. `--deny-orgs '*'` refuses them all, and the analysis tools keep working.

Only the org id is unspoofable. An alias can be re-pointed, so treat the rest as convenience, not a security boundary.

### Server flags

| Flag                      | Description                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--allow-production-orgs` | Treat production orgs like any other - no confirmation, no refusal. Only set this if production targets are intentional. |
| `--no-apex-execution`     | Refuse every Apex execution. The tool stays visible so agents know it exists. The three analysis tools are unaffected.   |
| `--deny-orgs`             | Refuse these orgs: org id, username, alias or instance URL, with `*` as a glob, or `type:` and an org type. |

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
