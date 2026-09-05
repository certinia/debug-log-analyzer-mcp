# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Apex Log MCP Server - a Model Context Protocol (MCP) server for Apex Log Analysis. It provides AI agents with tools to analyze Salesforce Apex debug logs for performance bottlenecks and optimization opportunities.

## Development Commands

```bash
# Install dependencies
pnpm install

# Build the TypeScript project
pnpm run build

# Development with watch mode
pnpm run dev

# Run the server standalone
pnpm start
```

## Architecture

### Core Components

- **src/index.ts**: CLI entry point (`bin`) — parses flags, constructs and runs the server
- **src/server.ts**: Main MCP server implementation (`createApexLogServer`, `runStdioServer`, `parseServerConfig`)
  - Implements 4 MCP tools: `apexlog_list_slow_operations`, `apexlog_get_summary`, `apexlog_list_limit_risks`, `apexlog_execute_anonymous`
  - Uses stdio transport for communication
  - Handles file validation, log parsing, analysis, and anonymous Apex execution

- **src/tools/responseShaping.ts**: Shared helpers for keeping responses lean — `omitEmpty`, `toLimitRows`, `toNamespaceLimitRows`, `roundMs`, `roundPercent`, `NS_TO_MS`

- **src/tools/apexLogSource.ts**: The one way the three analysis tools get a log — `loadApexLog` (reads and parses, caching the last parse by path and a fingerprint of everything a stat can see — inode, size, and modification and change time in nanoseconds, so a `cp -p` that keeps the modification time still misses; the file is opened once and both the stat and the read go to that handle, so nothing can put a different file at the path between the two; the slot holds the in-flight promise, so concurrent callers share one parse and a failed read is not kept; it is dropped five minutes after its last use, on an `unref`ed timer, because a parsed log holds four to five times the size of the file) and `walkLog`

- **`@apexdevtools/apex-log-parser`**: the parser, as a dependency. Nothing here parses a log. Runtime values (`parse`, the event classes for `instanceof`) come from the package root; every type and the const companions (`LOG_LEVEL`, `ALL_LIMIT_METRICS`) come from `@apexdevtools/apex-log-parser/types`. Read `debugCategory` for an event's category, never `category` — that one is a grouping for a UI and is slated for deprecation. `src/tools/operations.ts` reads `category` for one thing only, and not as a category: a non-empty one is what says an event has a duration, because the parser assigns it in the `DurationLogEvent` constructor alone and publishes no other flag for it.

  `tests/parserContract.test.ts` pins the assumptions the tools rest on, against a real parse — no other suite would notice a parser upgrade that broke one. Test expectations derive from the parser's exports wherever it publishes the fact, so the lists are pinned once there and nowhere else. One assumption is a known defect: `ApexLog.size` counts UTF-16 code units despite being documented as bytes, so `fileSizeBytes` under-reads a log that is not ASCII. Fixed upstream in 0.2.0 ([apex-log-parser#70](https://github.com/apex-dev-tools/apex-log-parser/issues/70)), so the upgrade carries it; that case failing is the signal the figure moved.

### Key Data Structures

- `ApexLog`: Root log structure with duration, governor limits, namespaces
- `LogEvent`: One parsed event, with its parent and children
- `Operation`: One timed thing the transaction did, with its timing and resource usage
- `GovernorLimits`: `{ snapshots, final, peak, byNamespace }`. Every tool reports **`peak`** — a counter falls when the frame that spent it exits, so `final` reads below the figure the platform enforced.

### MCP Integration

This server is designed to integrate with the Apex Log Analyzer VS Code extension:

- Registered automatically by the extension
- Communicates via MCP protocol over stdio
- Provides structured JSON responses for AI analysis

## TypeScript Configuration

- Target: ES2022
- Module: NodeNext (module + moduleResolution)
- Strict mode plus extra strictness (noUncheckedIndexedAccess, noImplicitOverride, verbatimModuleSyntax, isolatedModules)
- Output to `dist/` directory
- Emits `.js` only — no source maps or declarations

## File Structure

```
src/
  index.ts          # CLI entry point (bin)
  server.ts         # MCP server implementation
  tools/            # One module per MCP tool
  salesforce/       # Org connection, org classification, debug levels, trace flags, users
  policy/           # Per-call authorization for anonymous Apex execution
dist/               # Compiled JavaScript output
```

## Tools

The server provides four main capabilities:

1. **Performance Analysis**: Ranks every timed operation by self time, with detailed metrics
2. **Log Summary**: High-level execution statistics and governor limit usage
3. **Bottleneck Detection**: Analyzes CPU, database, and method performance patterns
4. **Execute Anonymous**: Executes anonymous Apex code snippets, saves the debug log to a file, and returns a summary with the file path

Log analysis tools (1-3) accept absolute file paths to `.log` files and return structured JSON for AI processing.

## Naming

Every tool, parameter and response field follows the rules in [DEVELOPING.md](DEVELOPING.md#-naming-tools-and-fields) — read them before you add or rename one. In short: prefix every tool `apexlog_`; the verb states the shape of the result (`get_` one, `list_` many, `search_` many matched to a caller query, `create`/`update`/`delete`/`write_` one resource written, `execute`/`run_` an effect outside the server) and the noun states what the result is; `analyze`, `process`, `handle`, `manage`, `find`, `detect`, `check` and `fetch` are banned; fields name the fact and not the calculation, carry their unit (`durationSelfMs`, `fileSizeBytes`), use `total` only for "including children" and `self` only for "excluding them" (so `durationTotalMs` names a log's duration and a row's alike), keep one name per fact across all tools, count as `<noun>Count`, fold acronyms in lowerCamel, and state booleans as bare adjectives (`truncated`).

## Response Shaping

Responses are TOON-encoded and deliberately lean, but the saving comes from shape, never from dropping a fact — see the conventions in [DEVELOPING.md](DEVELOPING.md#️-shaping-tool-responses) and the helpers in `src/tools/responseShaping.ts`. In short: restructure before you delete (flatten nested objects into TOON tables — `toLimitRows` is the worked example, 45% cheaper than the nested form and still complete); always report a fixed-schema field even at zero, because an absent count cannot be told apart from one that was never parsed; use `omitEmpty` **only** for occurrence lists, where absence unambiguously means nothing happened; never report the same figure twice; never state what the caller can derive from the numbers beside it; never echo the caller's input back; round durations and percentages (`roundMs`/`roundPercent`); and keep every row of a table on the same key set so TOON keeps its one-header-plus-one-line-per-row form.

Concretely: `apexlog_list_slow_operations` returns no prose `summary` and no `recommendations` — its one unique fact beside the table is the scalar `returnedSelfPercentage`, and its `heapSelfNetBytes` column and `returnedHeapPercentage` scalar are present only under the `sortBy` that ranks on them, because the caller's own parameter is what says whether an absent field means unmeasured; `apexlog_get_summary` returns no `file`, all thirteen governor limits as `{limit, used, max}` rows, the limits each namespace consumed as `{namespace, limit, used}` rows, one `timeByCategory` row per debug log category, keyed the way `debugLevels` is so a zero can be read against it, the full `debugLevels` list, and `truncated` and `thrownCount` as fixed fields — omitting `skippedBytes` unless the platform dropped content and `fatalErrors` unless a transaction died, because the parser's own diagnostics come to 6,645,879 tokens on the worst of 124 real logs; `apexlog_list_limit_risks` returns one `atRisk` table of `{limit, used, max, usedPercentage}` rows and reports it even when empty, beside the `threshold` that selected them, because a selection with no stated cutoff cannot be read; `apexlog_execute_anonymous` states `outputDirCreated` rather than advising the caller to write a `.gitignore`.

The same rule governs the **tool definitions**, which every client loads on every turn whether a tool is called or not (`tools/list` is ~1,093 tokens for the four tools). Say each thing once: an enum already lists its values, so a `.describe()` must not repeat them — this is why `debugLevel` is one `z.partialRecord(z.enum(TRACE_CATEGORIES), z.enum(LOG_LEVELS))` with a single description rather than ten per-category properties, and why `LOG_LEVELS` and `TRACE_CATEGORIES` live only in `src/salesforce/debugLevels.ts`. A description earns its tokens only if the agent acts on it: response-shaping policy is a contributor fact and belongs here and in DEVELOPING.md, not on the wire. Set `title` at the top level only — `annotations.title` is a duplicate alias and is sent twice. Anything true of every tool (durations are milliseconds, which tool to start with) goes in the server `instructions` once.

`pnpm run eval` (`scripts/eval.mjs`, wired into CI) is the gate for response-shape changes: it drives the built server over stdio against `tests/eval/fixtures/` and checks answerability, no duplication, a token budget and golden files. Once per run it also budgets the tool definitions — see [Shaping Tool Definitions](DEVELOPING.md#️-shaping-tool-definitions) — and regenerates both token cost tables in `README.md`, between the `<!-- token-cost-definitions -->` and `<!-- token-cost-answers -->` markers, so any change that moves a published figure fails until the README is regenerated with it. The jest suite cannot do this — `moduleNameMapper` swaps `@toon-format/toon` for a JSON stand-in, so it never sees the real encoding. Re-record goldens with `pnpm run build && pnpm run eval:update` and read the diff.

`outputSchema`/`structuredContent` are not implemented yet, and the reason is cost, not the spec: serializing the payload into a text block beside `structuredContent` is a `SHOULD` for old clients, and the spec's own example pairs a schema with an unrelated text block, so a lean TOON block stays legal. What is unresolved is that `outputSchema` is charged in `tools/list` on every turn, and that a client is free to read `structuredContent` instead of our text block, which would spend the shaping saving. Measure both before implementing — see #66.
Anonymous execution (4) accepts multi-line strings containing Apex, saves the resulting debug log to a local file (default: `.apex-log-mcp/` in the project root), and returns a summary with the file path. The `outputDir` parameter overrides the default save location. It supports an optional `debugLevel` parameter to configure trace flag log levels per category or set all categories at once. The response includes the org alias alongside the username when available, plus the detected org type.

`apexlog_execute_anonymous` is **always registered** so agents can discover it; authorization happens per call in `src/policy/orgExecutionPolicy.ts`. `src/salesforce/orgClassification.ts` identifies the target org (`sandbox`, `scratch`, `trial`, `developer`, `production`, or `unknown` when it cannot be queried), caching one `Organization` query per org id for the server's lifetime. Non-production orgs run silently. Production and `unknown` orgs need either the `--allow-production-orgs` flag or a per-call user confirmation via MCP elicitation; without either, the call is refused with an `isError` result whose text explains both routes. Authorization runs before any `DebugLevel` or `TraceFlag` record is created, so refused calls leave the org untouched. `--no-apex-execution` refuses every call before contacting Salesforce and marks the tool `[DISABLED on this server]` in its description. The 1.x `--allowed-orgs` flag is accepted but ignored, with a stderr deprecation warning.

`@salesforce/core` is a value import only in the two modules that call it, and `src/server.ts` loads `executeAnonymous` with `await import()` inside the handler — its wire definition lives in `executeAnonymousDefinition.ts`, so registration stays synchronous. A session that only reads logs never loads the SDK: startup is about 55 ms, not 290 ms.

`src/index.ts` stays the `bin` entry point (`dist/index.js`) and does nothing but parse flags and call `runStdioServer`. `src/server.ts` holds `createApexLogServer`, `runStdioServer` and `parseServerConfig` and is free of import side effects, so tests can import it without spawning a server or parsing the test runner's own argv.
