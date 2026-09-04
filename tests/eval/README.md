# Eval fixtures and golden files

`pnpm run eval` drives the **built** server over stdio against the logs in `fixtures/` and asserts
four things per (tool, fixture) pair: that realistic questions are still answerable, that no figure
is reported twice, that the payload is under a token budget, and that it matches the committed
golden file. Two more checks run once per run: every tool definition is under a token budget and
still holds the keywords clients select on, and both tables in
[Token Cost](../../README.md#token-cost) — the `token-cost-definitions` and `token-cost-answers`
marker blocks — are generated from the run. See [`scripts/eval.mjs`](../../scripts/eval.mjs).

The answers table publishes one row per tool, against the one log `PUBLISHED_FIXTURE` names — see
its comment for why.

## Fixtures

| File | Provenance | What it pins |
| --- | --- | --- |
| `governor-heavy.log` | Slices of the [Apex Log Analyzer sample log](https://github.com/certinia/debug-log-analyzer) (`sample-app/debug-logs/sample-log.log`): the transaction start, a DML insert, a managed-package section for `core_pkg` and `srm_pkg` with a SOQL query, and the closing limit block. | CPU over its limit, SOQL/DML consumed, three namespaces, and a `FATAL_ERROR` — the only fixture that carries one, so it is the only one that reports `fatalErrors`. |
| `minimal.log` | A `System.debug('')` run: the smallest transaction that still emits a limit block. | Everything is zero. This is the fixture that fails if a zero is ever omitted instead of reported, because "no DML statements ran" has to be answerable from the payload. |
| `heap-heavy.log` | Hand-written: one method allocates and holds, another allocates then frees the same bytes. | Heap. Its limit block states heap as zero where its `HEAP_ALLOCATE` events do not, so it is the fixture that fails if the summary ever reports the block instead of the peak. `apexlog_get_summary` only — see below. |
| `truncated.log` | Hand-written: a `*** Skipped N bytes` region mid-log and a `MAXIMUM DEBUG LOG SIZE REACHED` marker at the end. | `truncated` and `skippedBytes`. No other fixture is partial, so without this the flag is unproven either way — and every figure in a partial log is a floor, so reading one as a total is the worst answer the server can give. `apexlog_get_summary` only — see below. |

`governor-heavy.log` is deliberately fragmentary — the whole sample log is 19 MB, and the slices keep
the fixture at ~40 KB while retaining every fact the tools report. One consequence of the slicing is
that it raises an `Unexpected-Exit` while reading `truncated: false`, which no unsliced log in a
124-log corpus does; the tools report neither, so nothing rests on it.

`FIXTURES_BY_TOOL` names the logs each tool is measured against, and it is not a cross product. Every
case is a server round trip and a golden file a reviewer has to read, so add a fixture to a tool only
where it pins something the other fixtures would miss. `heap-heavy.log` is in the summary alone, the
one tool whose answer its heap changes. `apexlog_list_limit_risks` does read heap, but this log's
heap sits under its risk threshold, and the rows `apexlog_list_slow_operations` would rank are kinds
`governor-heavy` pins already. What the parser's several heap measures mean is pinned in
`tests/parserContract.test.ts`, on a log of its own, which needs no server. `truncated.log` is there
on the same rule, and that suite reads it too.

## Golden files

`golden/<tool>.<fixture>.expected.txt` is the exact TOON payload an agent receives. When an output
shape changes on purpose:

```zsh
pnpm run build && pnpm run eval:update
```

Then read the diff — it is the review of the change, and the token counts printed alongside it are
the cost.
