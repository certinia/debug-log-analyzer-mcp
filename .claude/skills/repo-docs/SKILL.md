---
name: repo-docs
description: Where a fact belongs in this repo's docs, and the shape each file expects — README tools reference, generated token-cost blocks, MIGRATING, CLAUDE.md and DEVELOPING.md. Use when documenting a tool, parameter or response field, or when a doc figure no longer matches the code.
---

# Repo docs

Voice comes from the `developer-writing` skill. This skill says **which file** a fact belongs in and
**what shape** that file expects. Changelog entries have their own rules — use `changelog-entry`.

## One fact, one file

| Fact                                                       | File                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| What a tool returns, its parameters, its response fields   | `README.md`, Tools Reference             |
| What a 1.x caller must change                              | `MIGRATING.md`                           |
| What a reader of the released package can see changed      | `CHANGELOG.md` (`changelog-entry` skill) |
| Why a response is shaped that way; the shaping rules       | `DEVELOPING.md`                          |
| What a contributor or agent needs before touching the code | `CLAUDE.md`                              |
| Why a budget number is what it is                          | the comment beside it in `scripts/eval.mjs` |

Response-shaping policy never reaches the wire: not a `.describe()`, not a tool description. It is a
contributor fact.

## README shape, per tool

The Tools Reference gives each tool, in this order:

1. One paragraph of what it answers and what it is best for — the served tool description in
   README voice, not a copy of it.
2. `Rows are {…}` — the full column set, then any column that is conditional and what decides it.
3. One short paragraph per extra table (`capturedAt`, `queryPlans`, `timeByCategory`), saying what
   it joins to.
4. The parameter table: `Parameter | Type | Required | Description`, in schema order, `string[]` for
   an array. Repeat the default in the description, as `(default: 10)`.

A new parameter means a table row **and** a line of prose if it changes what the rows carry.

## Generated blocks — never hand-edit

`README.md` holds two tables between markers, both written by the eval run:

- `<!-- token-cost-definitions:start -->` … `:end`
- `<!-- token-cost-answers:start -->` … `:end`

`pnpm run build && pnpm run eval:update` regenerates them with the goldens. `pnpm run eval` fails
when they drift, so a hand edit is a CI failure, not a saving.

The prose **around** those tables is hand-written and does not regenerate — the paragraph naming
what the unsliced 19.7 MB sample log costs is measured with
`node scripts/eval.mjs --report <log>` and has to be re-measured by hand when a response shape
moves. It is the one figure in the file nothing checks.

## Figures in prose

Any figure a reader can check must match the code: percentages against 1.x, token counts, corpus
sizes, row caps such as `NAME_LIMIT` and the page budget. When a change moves one, grep the docs for
the old number before you commit — `README.md`, `DEVELOPING.md`, `CLAUDE.md` and `MIGRATING.md` all
quote them.

## MIGRATING

One section per thing a 1.x caller must do, each with a mapping table where the change is a rename,
and a sentence naming what to grep for in their own prompts, agents and skills. No rationale — that
is the changelog's job and the issue's.
