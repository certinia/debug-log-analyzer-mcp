# Eval fixtures and golden files

`pnpm run eval` drives the **built** server over stdio against the logs in `fixtures/` and asserts
four things per (tool, fixture) pair: that realistic questions are still answerable, that no figure
is reported twice, that the payload is under a token budget, and that it matches the committed
golden file. One more check runs once per run: the table in
[Token Cost](../../README.md#token-cost) is generated from the run. See
[`scripts/eval.mjs`](../../scripts/eval.mjs).

## Fixtures

| File | Provenance | What it pins |
| --- | --- | --- |
| `governor-heavy.log` | Slices of the [Apex Log Analyzer sample log](https://github.com/certinia/debug-log-analyzer) (`sample-app/debug-logs/sample-log.log`): the transaction start, a DML insert, a managed-package section for `core_pkg` and `srm_pkg` with a SOQL query, and the closing limit block. | CPU over its limit, SOQL/DML consumed, three namespaces, a `FATAL_ERROR`, and — because it is a trimmed slice — a non-zero `parsingErrors`. |
| `minimal.log` | A `System.debug('')` run: the smallest transaction that still emits a limit block. | Everything is zero. This is the fixture that fails if a zero is ever omitted instead of reported, because "no DML statements ran" has to be answerable from the payload. |

`governor-heavy.log` is deliberately fragmentary — the whole sample log is 19 MB, and the slices keep
the fixture at ~40 KB while retaining every fact the tools report. Its `parsingErrors` count is an
artefact of that slicing, and is useful: it exercises the "did the log parse cleanly?" question with
a non-zero answer, where `minimal.log` answers it with zero.

## Golden files

`golden/<tool>.<fixture>.expected.txt` is the exact TOON payload an agent receives. When an output
shape changes on purpose:

```zsh
pnpm run build && pnpm run eval:update
```

Then read the diff — it is the review of the change, and the token counts printed alongside it are
the cost.
