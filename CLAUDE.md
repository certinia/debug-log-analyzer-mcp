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
- **src/server.ts**: `createApexLogServer`, `runStdioServer` and `parseServerConfig`. Registers the ten tools over stdio, and takes no import side effects, so tests can import it without spawning a server.
- **src/tools/responseShaping.ts**: the shared response helpers - `omitEmpty`, `toLimitRows`, `toNamespaceLimitRows`, `roundMs`, `roundPercent`, `NS_TO_MS`, `elide`, `NAME_LIMIT`.
- **src/tools/localFile.ts**: `absolutePathSchema` and `fileReadError`, shared by every tool that reads a local file - a log or a file of Apex.
- **src/tools/apexLogSource.ts**: `loadApexLog` and `walkLog`, the one way the analysis tools get a log. It caches the last parse against a stat fingerprint, shares one parse between concurrent callers, and drops it five minutes after its last use, because a parsed log holds four to five times the size of the file.
- **`@apexdevtools/apex-log-parser`**: the parser, as a dependency - nothing here parses a log. Every value, type and const comes from the package root; 0.2.0 removed the `/types` entry point. Read `debugCategory` for an event's category, never `category`: that one is a UI grouping slated for deprecation, and `src/tools/operations.ts` reads it only as the flag that says an event has a duration.

  `tests/parserContract.test.ts` pins what the tools assume, against a real parse - no other suite would notice a parser upgrade that broke one.

### Key Data Structures

- `ApexLog`: root log structure with duration, governor limits, namespaces
- `LogEvent`: one parsed event, with its parent and children
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
  tools/            # One module per MCP tool
  salesforce/       # Org connection, org classification, debug levels, trace flags, users
  policy/           # Per-call authorization for anonymous Apex execution
dist/               # Compiled JavaScript output
```

## Tools

1. **`apexlog_list_slow_operations`**: ranks every timed operation by self time
2. **`apexlog_get_summary`**: execution statistics and governor limit usage
3. **`apexlog_list_limit_risks`**: the limits nearest their ceiling
4. **`apexlog_execute_anonymous`**: runs Apex, saves the log, returns its path
5. **`apexlog_list_org_logs`**: the debug logs stored in an org, filtered, sorted and paged in SOQL
6. **`apexlog_get_org_logs`**: downloads stored logs by id or the newest N, returns their paths
7. **`apexlog_delete_org_logs`**: deletes stored logs by id or by the list tool's filters, to free the org's log storage
8. **`apexlog_list_trace_flags`**: the trace flags not yet expired, with their levels
9. **`apexlog_create_trace_flag`**: traces a user, or sets a class's or trigger's levels, for a while; refused when the entity has a flag of its log type already
10. **`apexlog_delete_trace_flags`**: deletes trace flags by id, to stop logging now

Tools 1-3 take an absolute path to a `.log` file. Tools 4-10 reach an org through `openOrg` (`src/salesforce/orgAccess.ts`), so the deny list holds for all of them; only a write (4, 7, 9 and 10) meets the production gate.

## Naming

[DEVELOPING.md](DEVELOPING.md#-naming-tools-and-fields) holds the rules - read them before you add or rename a tool, parameter or field. The ones most easily missed: a field carries its unit (`durationSelfMs`, `fileSizeBytes`), `total` means including children and `self` excluding them, and one fact keeps one name across every tool.

## Response Shaping

Responses are TOON-encoded and lean, but the saving comes from shape, never from dropping a fact - conventions in [DEVELOPING.md](DEVELOPING.md#️-shaping-tool-responses), helpers in `src/tools/responseShaping.ts`. Two rules bite most often: report a fixed-schema field even at zero, since an absent count reads as one never parsed, and use `omitEmpty` **only** for occurrence lists.

Decisions worth not undoing: no prose `summary` or `recommendations`; report a table even when empty, beside the parameter that selected it, since a cutoff left unstated cannot be read; a column only one `sortBy` populates appears under that `sortBy` alone.

The tool definitions follow the same rule and are charged on every turn, called or not - the budgets and the checks are in [`scripts/eval.mjs`](scripts/eval.mjs). An enum already lists its values, so a `.describe()` must not repeat them; set `title` at the top level only, because `annotations.title` is an alias and is sent twice; anything true of every tool goes in the server `instructions` once.

`pnpm run eval` (`scripts/eval.mjs`, wired into CI) is the gate: it drives the built server over stdio and checks answerability, duplication, token budgets, golden files, and that startup loads no Salesforce SDK - none of which the jest suite can do, because it swaps TOON for a JSON stand-in. It also generates the README's token tables, parameter tables and response shapes, so a change that moves any of them fails until the README is regenerated with it. Re-record with `pnpm run build && pnpm run eval:update` and read the diff.

`outputSchema`/`structuredContent` are unimplemented on cost, not on the spec: the schema is charged in `tools/list` every turn, and a client is free to read `structuredContent` instead of our text block, spending the shaping saving. Measure both before implementing - see #66.

## Anonymous Apex

`apexlog_execute_anonymous` writes the debug log under `.apex-log-mcp/`, or `outputDir`, and returns the path beside a summary, the org alias and the detected org type. Left out, `debugLevel` runs at the user's active `USER_DEBUG` flag's levels, else the defaults; it sets them per category, or all at once. The levels always go in the header, because with no header the returned log is empty. It never changes the user's trace flag.

It is always registered so agents can discover it; each call passes the deny list below, then is authorized in `src/policy/orgExecutionPolicy.ts`. A production org, or one whose type cannot be read, needs `--allow-production-orgs` or a per-call confirmation, decided before any `DebugLevel` or `TraceFlag` is written. `--no-apex-execution` refuses every call; the 1.x `--allowed-orgs` is accepted, ignored and warned about.

`--deny-orgs` refuses outright, in `src/policy/orgDenyList.ts`. A deny beats `--allow-production-orgs` and beats a confirmation. `openOrg` in `src/salesforce/orgAccess.ts` holds this order for every org tool. It runs `identityRefusal` on what `readLocalOrg` reads from the local sf files, before `connectOrg`, because `Org.create` can call the org; `connectOrg` reuses that `AuthInfo`, so the org connected is the org checked. `typeRefusal` runs after `classifyOrg` and before `authorizeOperation`, which knows nothing of denies. Only an org id is unspoofable, so the README documents the rest as convenience.

`@salesforce/core` loads only for this tool: `src/server.ts` reaches it through `await import()`, and `executeAnonymousDefinition.ts` holds the wire definition so registration stays synchronous. Startup is 55 ms, not 290 ms; an ESLint rule, `tests/salesforceCoreIsLazy.test.ts` and the `pnpm run eval` startup check keep it there.
