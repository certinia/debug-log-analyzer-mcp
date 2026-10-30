# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An MCP server that analyses Salesforce Apex debug logs for performance bottlenecks, governor limit usage and optimization opportunities.

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

- **src/index.ts**: the `bin` entry point (`dist/index.js`). Parses flags, calls `runStdioServer`, nothing else. A bad flag exits 1 with one `[apex-log-mcp]` line, checked by `pnpm run eval`.
- **src/server.ts**: `createApexLogServer`, `runStdioServer` and `parseServerConfig`. Registers the eight tools over stdio, and takes no import side effects, so tests can import it without spawning a server.
- **src/tools/responseShaping.ts**: the shared response helpers - `toonResult`, `omitEmpty`, `warningField`, `toLimitRows`, `toNamespaceLimitRows`, `limitUnitsClause`, `limitGatingCategory`, `roundMs`, `roundPercent`, `percentageOf`, `NS_TO_MS`, `NAME_LIMIT`, and the page every analysis table stops at - `fitPage`, `PAGE_CHAR_BUDGET`, `nextOffsetField` - with the `matches` filter they share.
- **src/tools/localFile.ts**: `absolutePathSchema`, `fileReadError`, `fsErrorWords` and `outsideRoots`, shared by every tool that reads or writes a local file - a log or a file of Apex.
- **src/tools/inputSchema.ts**: `toolInputSchema`, which wraps every tool's parameters so a parameter the tool does not have is refused, and the parameters the org tools share, worded once: `targetOrgSchema`, `outputDirSchema` and `levelsByCategorySchema`.
- **src/errors.ts**: `errorText`, what a caught value says, and `toolError`, a tool's refusal or failure as a result.
- **src/elide.ts**: `elide`, `elideAround` and `elideEnd`, which cut over-long text without splitting a character.
- **src/logLevels.ts**: the debug log's categories and levels - `DEBUG_CATEGORIES`, `TRACE_CATEGORIES`, `LOG_LEVELS`, `DEFAULT_TRACE_CONFIG` - with the levels a call asks for, `requestedLevels`, and their wording, `levelsClause`; and `declaredLevels` and `capturedAt`, which read the levels a log's header declared. It needs no org, so the analysis tools import it; `src/salesforce/debugLevels.ts` writes `DebugLevel` records from it.
- **src/tools/logStore.ts**: `openLogStore`, `writeDebugLog` and `saveStoredLog` - where every org tool saves a log, and never over a different one - and `unwritableLogDir`, which refuses a directory before a step that cannot be undone, and creates nothing.
- **src/tools/progress.ts**: `progressReporter`, the progress notifications of a long org call, sent only to a caller that asked.
- **src/tools/analysisTool.ts**: `defineAnalysisTool`, which states an analysis tool once - its name, title, description, own parameters and a pure `run(apexLog, args)` - and adds `logFilePath`, the read-only annotations, the load and the TOON encoding. Test a tool through `run` on a parsed log; `tests/analysisTool.test.ts` tests the shell. `src/tools/analysisTools.ts` lists every analysis tool, for the server and the tests.
- **src/salesforce/orgAccess.ts**: `OpenOrg`, which a handler gets as `open`, is the one way an org tool reaches an org. It runs the roots, the local org, the identity deny, the connect, the type deny and, for a write, the production gate, for one call of one tool. `bindOpenOrg` makes it, and only `src/server.ts` calls `bindOpenOrg`.
- **src/tools/\*Definition.ts**: an org tool's wire definition, `{ name, config }`; one module can hold two tools. A write tool's definition is a function of the refusal and carries it, so `registerOrgTool` answers a refused call before the handler loads - copy a write tool, not a read tool, for a write. A definition loads at startup and loads no Salesforce SDK; the handler loads on its first call. A new org tool touches its definition, its handler, one `registerOrgTool` call in `src/server.ts`, its suite, which wires the handler through `tests/support/wiredOrgTool.ts`, the tool count and handler mocks in `tests/server.test.ts`, and a `DEFINITION_BUDGET` entry in `scripts/eval.mjs`. `pnpm run eval` names anything else it lacks, and `pnpm run eval:update` writes its README tables.
- **src/apexLog/**: the one module that imports the parser; an ESLint rule refuses it anywhere else. `index.ts` holds the parser's rules the tools share - `textOf`, `countOf`, `ceilingOf`, `multipleLogsWarning`, `LOG_EVENT_ID`, and the parser's `DEFAULT_NAMESPACE` - and the readers of one event from `log.columns`: `typeAt`, `frameTypeAt`, `namespaceAt`, `textAt`, and `totalAt` for `countOf(...).total`. A pass over every event reads `log.columns`, not event objects: the parser makes a new object on each read of an event. Each column reader takes its column, so a loop reads it from `log.columns` once; `textAt` alone takes the log. `source.ts` holds `loadApexLog`, the one way the analysis tools get a log. It caches the last parse against a stat fingerprint, shares one parse between concurrent callers, and drops it five minutes after its last use, because a parsed log holds one to two times the size of the file.
- **`@apexdevtools/apex-log-parser`**: the parser, as a dependency - nothing here parses a log. Every value, type and const comes from the package root. Read `debugCategory` for an event's category, never `category`: that one is a UI grouping slated for deprecation. Read `isFrame` for whether an event has a duration.

  `tests/parserContract.test.ts` pins what the tools assume, against a real parse - no other suite would notice a parser upgrade that broke one.

### Key Data Structures

- `ApexLog`: root log structure with duration, governor limits, namespaces
- `ApexEvent`: one parsed event, with its parent and children
- `Operation`: one timed thing the transaction did, with its timing and resource usage
- `GovernorLimits`: `{ snapshots, final, peak, byNamespace }`. Every tool reports **`peak`** - a counter falls when the frame that spent it exits, so `final` reads below the figure the platform enforced.

### MCP Integration

Users add it to their MCP client by hand (`.vscode/mcp.json`, `claude mcp add`), and it is spoken to over stdio.

## TypeScript Configuration

- Target: ES2022
- Module: NodeNext (module + moduleResolution)
- Strict mode plus extra strictness (noUncheckedIndexedAccess, noImplicitOverride, verbatimModuleSyntax, isolatedModules)
- Output to `dist/` directory
- Emits `.js` only - no source maps or declarations

## File Structure

```
src/
  index.ts          # CLI entry point (bin)
  server.ts         # MCP server implementation
  *.ts              # Helpers every layer may import, which import no layer: errors, elide, logLevels, compileGuards
  apexLog/          # The one module that imports the log parser
  tools/            # One module per MCP tool
  salesforce/       # Org connection, org classification, debug levels, trace flags
  policy/           # Org deny list for every org tool; production gate for the writes
dist/               # Compiled JavaScript output
```

## Tools

1. **`apexlog_list_slow_operations`**: ranks every timed operation by self time
2. **`apexlog_get_summary`**: execution statistics and governor limit usage
3. **`apexlog_list_limit_risks`**: the limits nearest their ceiling
4. **`apexlog_search_events`**: a log's events in log order, filtered and paged, with their text and place but no timing
5. **`apexlog_execute_anonymous`**: runs Apex, saves the log, returns its path
6. **`apexlog_list_org_logs`**: the debug logs stored in an org, filtered, sorted and paged in SOQL
7. **`apexlog_get_org_logs`**: downloads stored logs by id or the newest N, returns their paths
8. **`apexlog_create_trace_flag`**: traces a user, or sets a class's or trigger's levels, for a while; refused when the entity has a flag of its log type already

Tools 1-4 take an absolute path to a `.log` file. Tools 5-8 reach an org through `openOrg` (`src/salesforce/orgAccess.ts`), so the deny list holds for all of them; only a write (5 and 8) meets the production gate.

No tool deletes stored logs, or lists or deletes trace flags: the need is rare, Setup and `sf` meet it, and their definitions would be charged on every request - the cost is in the `DEFINITION_TOTAL_CAP` comment in `scripts/eval.mjs`.

## Naming

[DEVELOPING.md](DEVELOPING.md#-naming-tools-and-fields) holds the rules - read them before you add or rename a tool, parameter or field. The ones most easily missed: a field carries its unit (`durationSelfMs`, `fileSizeBytes`), `total` means including children and `self` excluding them, and one fact keeps one name across every tool.

## Response Shaping

Responses are TOON-encoded and lean, but the saving comes from shape, never from dropping a fact - conventions in [DEVELOPING.md](DEVELOPING.md#️-shaping-tool-responses), helpers in `src/tools/responseShaping.ts`. Two rules bite most often: report a fixed-schema field even at zero, since an absent count reads as one never parsed, and use `omitEmpty` **only** for occurrence lists.

A decision's evidence - a measurement, a rejected alternative - goes in a doc comment on the code it governs, or in `.claude/rules/` when it is Salesforce behaviour tested in an org - not in DEVELOPING.md, which holds rules only. Read those comments before you change the code. The rules most easily broken: no prose `summary` or `recommendations`; report a table even when empty, beside the parameter that selected it, since a cutoff left unstated cannot be read; a column only one `sortBy` populates appears under that `sortBy` alone.

The tool definitions follow the same rule and are charged on every turn, called or not - the budgets and the checks are in [`scripts/eval.mjs`](scripts/eval.mjs). An enum already lists its values, so a `.describe()` must not repeat them; set `title` at the top level only, because `annotations.title` is an alias and is sent twice; anything true of every tool goes in the server `instructions` once.

`pnpm run eval` (`scripts/eval.mjs`, wired into CI) is the gate: it drives the built server over stdio and checks answerability, duplication, token budgets, golden files, and that startup loads no Salesforce SDK - none of which the jest suite can do, because it swaps TOON for a JSON stand-in. It also generates the README's token tables, parameter tables and response shapes, so a change that moves any of them fails until the README is regenerated with it. Re-record with `pnpm run build && pnpm run eval:update` and read the diff.

`outputSchema`/`structuredContent` are unimplemented on cost, not on the spec: the schema is charged in `tools/list` every turn, and a client is free to read `structuredContent` instead of our text block, spending the shaping saving. Measure both before implementing - see #66.

## Anonymous Apex

`apexlog_execute_anonymous` writes the debug log under `.apex-log-mcp/`, or `outputDir`, and returns the path beside a summary, the org alias and the detected org type. Left out, `debugLevel` runs at the user's active `USER_DEBUG` flag's levels, else the defaults; it sets them per category, or all at once. A live `DEVELOPER_LOG` flag outranks all of these, `debugLevel` too. The levels always go in the header, because with no header the returned log is empty. It never changes the user's trace flag.

It is always registered so agents can discover it; each call passes the deny list below, then is authorized in `src/policy/orgExecutionPolicy.ts`. A production org, or one whose type cannot be read, needs `--allow-production-orgs` or a per-call confirmation, decided before any `DebugLevel` or `TraceFlag` is written. `--no-apex-execution` refuses every call, and `--read-only` refuses every call to it and to `apexlog_create_trace_flag`, both in `src/server.ts` before the tool loads; the 1.x `--allowed-orgs` is accepted, ignored and warned about.

`--deny-orgs` refuses outright, in `src/policy/orgDenyList.ts`. A deny beats `--allow-production-orgs` and beats a confirmation. `openOrg` in `src/salesforce/orgAccess.ts` holds this order for every org tool. It runs `identityRefusal` on what `readLocalOrg` reads from the local sf files, before `connectOrg`, because `Org.create` can call the org; `connectOrg` reuses that `AuthInfo`, so the org connected is the org checked. `typeRefusal` runs after `classifyOrg` and before `authorizeOperation`, which knows nothing of denies. Only an org id is unspoofable, so the README documents the rest as convenience. `registerOrgTool` in `src/server.ts` binds `openOrg` to the tool's registered name with `bindOpenOrg`, and gives the result to the handler as `open`. Lint rules keep `bindOpenOrg` out of `src/tools/`, by a static or a dynamic import. So a handler does not bind another tool's name, and does not spend that tool's confirmation.

`@salesforce/core` loads only for the org tools: `src/server.ts` reaches each handler through `await import()`, and the `*Definition.ts` modules hold the wire definitions so registration stays synchronous. Startup is 55 ms, not 290 ms; an ESLint rule, `tests/salesforceCoreIsLazy.test.ts` and the `pnpm run eval` startup check keep it there.
