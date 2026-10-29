# Adopt apex-log-parser 0.4, behind one log seam

Date: 2026-10-29. Status: agreed design, not built.

## Goal

Move from `@apexdevtools/apex-log-parser` `^0.3.0` to `0.4.0`. Put every use of the parser behind
one module, so the next parser change touches that module and the fields the tools read. Measure
the speed and memory change on real logs.

## Why

0.4.0 is a rewrite. Release notes and the 0.4.0 README state:

- Parse is about 6 times faster than 0.3. A 20 MB log parses in 33 ms and holds 11 MB; 0.3 took
  221 ms and held 190 MB.
- `parse` is async. It reads a string, bytes, a `Blob`, a `fetch` `Response`, a `ReadableStream` or
  an `AsyncIterable<Uint8Array>`.
- `ApexLog.size` counts bytes (apex-log-parser#70).

The API breaks:

- No event classes and no `instanceof`. Use `event.type`, `event.kind` or `log.ofType()`.
- Each read makes a new event object. `log.event(1) !== log.event(1)`. Key a `Map` or `Set` by `id`.
- Exit lines are not events. They set the end and duration of their frame.
- `null` means "not stated". 0.3 gave `''`, `0` or `'default'`. Rollups are `SelfTotal | null`;
  `namespace` is `string | null`.
- Renames: `governorLimits` → `limits`, `timestamp` → `startTimestamp`, `exitStamp` →
  `endTimestamp`, `isParent` → `isFrame`, `logIssues` → `issues`, `eventIndex` → `id`,
  `ALL_LIMIT_METRICS` → `LIMIT_METRICS`, `LOG_LEVEL` → `LEVEL`.
- The timeline `category` field is gone. `src/tools/operations.ts` read it as "this event has a
  duration".
- The explain plan is in `details` of the `SOQL_EXECUTE_EXPLAIN` event, not on a class.
- The root export is `dist/node.js` for Node. `jest.config.js` maps to `dist/index.js`, which is
  gone.

Today `src/tools/apexLogSource.ts` owns the load only. Parser types are imported in 10 `src`
modules and 12 test files.

## Decisions

| Question | Decision |
| --- | --- |
| Seam depth | An owned module and a lint ban. Tools still read parser events; no own domain model. |
| A `null` count | Read as 0 in the seam; a `null` namespace as `default`. Responses do not change. |
| Org downloads | Not in scope. Only the local file is streamed. |
| Seam home | `src/apexLog/`, a layer beside `src/salesforce/` and `src/policy/`. |
| Measurement | A bench script, run on `main` and on the branch, on a local directory of real logs. |
| Log corpus in comments | Reword to "real logs". Keep each measured figure and decision; drop log counts. |

Rejected:

- Load only, in `apexLogSource.ts`. The next parser change spreads to every module again.
- A full adapter to own types. It copies every event, against the parser's lazy views, and is the
  largest rewrite.
- Grow `src/tools/apexLogSource.ts`. `src/logLevels.ts` must import no layer, and would then
  import from `src/tools/`.
- Show "not recorded" for a `null` count now. It changes response shapes, README tables, token
  budgets and golden files in the same change as the parser. `capturedAt` already says which levels
  the log recorded.
- Stream org downloads. `connection.request<string>` gives the body as one string; a stream needs
  an authenticated `fetch` beside `@salesforce/core`. The `apexlog_execute_anonymous` log comes in
  a SOAP envelope and cannot stream.
- Parse the `apexlog_execute_anonymous` text while the file is written. It saves milliseconds on a
  call that spends seconds on the org, and adds a cache entry whose fingerprint belongs to bytes
  the cache did not read.

## Design

### `src/apexLog/`

The only module that imports `@apexdevtools/apex-log-parser`.

- `index.ts`: the public surface.
  - Parser types, under the parser's names: `ApexLog`, `ApexEvent`, `EventType`, `DebugCategory`,
    `Level`, `Limits`, `LimitMetric`, `NamespaceLimits`, `GovernorLimits`, and the ones the
    migration finds it needs.
  - Consts: `LIMIT_METRICS`, `LEVEL`.
  - `loadApexLog`, `clearApexLogCache`, `walkLog`.
  - The null policy: `countOf(rollup: SelfTotal | null): SelfTotal` gives zeros for `null`;
    `namespaceOf(event)` gives `"default"` for `null`. To show "not recorded" later, change these
    and the callers that format them.
- `source.ts`: moved from `src/tools/apexLogSource.ts`.
  - Open once, stat the handle, fingerprint, as now.
  - Give `parse` the bytes from `handle.createReadStream()`, not `handle.readFile("utf-8")`. No
    UTF-16 copy of the log is held.
  - Keep the one slot, the shared in-flight promise, the drop of a failed parse and the idle
    eviction. Replace the "four to five times the size of the file" figure with the bench figure,
    and keep the 5-minute eviction unless the bench says otherwise.

### Enforcement

- ESLint `@typescript-eslint/no-restricted-imports` bans the parser everywhere except
  `src/apexLog/**`, `tests/apexLog/**` and `tests/parserContract.test.ts`. A later ESLint block
  replaces the rule's options, so the ban goes in each block that sets the rule.
- `jest.config.js` maps the parser to `dist/node.js`.

### Migration, per module

| Module | Change |
| --- | --- |
| `src/tools/operations.ts` | `isRankable`: `category !== ""` → `isFrame`. Rollups through `countOf`, namespace through `namespaceOf`. `type` is never `null`; drop `"Unknown"`. |
| `src/tools/queryPlans.ts` | Read the plan from `details` of the `SOQL_EXECUTE_EXPLAIN` child. |
| `src/tools/searchEvents.ts` | Renamed fields. Key any `Map`, `Set` or `===` on events by `id`. |
| `src/tools/getLogSummary.ts`, `src/tools/listLimitRisks.ts`, `src/tools/responseShaping.ts` | `limits`, `LIMIT_METRICS`, `issues`. `size` is bytes. |
| `src/logLevels.ts`, `src/salesforce/anonymousApex.ts` | `debugLevels` is `Partial<Record<DebugCategory, Level>>`; `LEVEL`. |
| `src/tools/listSlowOperations.ts`, `src/tools/analysisTool.ts`, `src/tools/executeAnonymous.ts` | Imports only. `executeAnonymous` keeps "save, then `loadApexLog(file)`". |

Rule: a response changes only where the parser's figure changed. Each changed golden value is
explained in the PR. Expected: `fileSizeBytes` on a log that is not ASCII; self times where 0.3
gave exit lines time.

### Facts to pin before the code uses them

`tests/parserContract.test.ts` pins these on 0.4, from a real parse:

1. A child event with no namespace gets its parent's. The `callerNamespace` comment relies on it.
2. `heapAllocated.self` is the signed net: allocations less deallocations. 0.4 adds `heapGross`.
3. Every timed event is a frame. `ENTERING_MANAGED_PKG` has no children.
4. Every event has a `debugCategory`.
5. `size` is bytes.

If one fails: stop, report it, and decide with the user.

## Testing

- `tests/support/logEvents.ts` builds the 0.4 shape: `id`, `isFrame`, `kind`, `details`, rollups
  `SelfTotal | null`, no `category`. It stays the one place a fixture tracks the parser.
- `tests/apexLogSource.test.ts` moves to `tests/apexLog/source.test.ts`. A new case: `parse` gets
  bytes, not a string. It catches a return to `readFile("utf-8")`.
- A lint case: a parser import outside `src/apexLog/` fails `pnpm run lint`.
- Gates: `pnpm test`, `pnpm run lint`, `tsgo --noEmit`, `pnpm run build && pnpm run eval`. Read each
  golden diff line by line.

## Measurement

`scripts/bench.mjs`, run as `pnpm run bench <dir>`.

- It imports the built `dist/`, and runs one `node --expose-gc` process per log, so one log's heap
  does not change the next.
- Per log, the median of 5 runs: cold `loadApexLog` time; each of the 4 analysis tools' `run`,
  warm; heap held after GC (`heapUsed + arrayBuffers`); peak RSS
  (`process.resourceUsage().maxRSS`).
- Output: medians per size bucket. No file names and no paths.
- Run on a build of `main` (0.3) and of the branch, on the same directory. The before and after
  table goes in the PR. The script stays, for the next parser change.

## Delivery

One concern per commit. Each commit is shown for approval first.

1. `docs:` reword the log-corpus comments to "real logs".
2. `refactor:` add `src/apexLog/` on 0.3, with the lint ban. No behaviour change; tests green.
3. `build(deps):` parser 0.4, the migration, and the streamed load. Not breaking: responses do not
   change.
4. `chore:` the bench script, with its results in the PR.
5. `docs:` CLAUDE.md core components, CHANGELOG.

Step 2 before step 3, so the upgrade diff shows the seam working: only `src/apexLog/` and the field
reads change.

## Follow-ups (issues, not this change)

- Stream `apexlog_get_org_logs` downloads to disk.
- Show "not recorded" for a `null` count.
- `log.columns` for repeated passes over every event.
- The parser's `worker` option, if the bench shows a parse that blocks too long.
