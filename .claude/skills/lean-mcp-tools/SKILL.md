---
name: lean-mcp-tools
description: Use when adding or editing an MCP tool definition — its name, title, description, inputSchema or annotations — when a server's tools/list looks expensive, when deciding whether a fact belongs in a tool description or the server instructions, or when the context cost of an MCP server needs measuring or budgeting.
---

# Lean MCP tools

A response is paid for when a tool is called. A **definition** is paid for on every request, called
or not, because the client sends all of them with each one. Server `instructions` sit between: once
per session. Put each fact where its audience reads it.

| Fact | Goes in |
| --- | --- |
| True of every tool ("all durations are in milliseconds") | `instructions` |
| Why a caller picks this tool over its neighbour | that tool's `description` |
| A value | the response |

## What a definition holds

- `name`, `title` — the display field. `annotations.title` is a second copy; drop it.
- `description` — the selection prompt: what it returns, when to pick it, nothing the schema below
  already says.
- `inputSchema` — a `describe` only for what the property name and its type cannot say.
- `annotations` — only spec hints that differ from the default **and** carry meaning.
  `destructiveHint` and `idempotentHint` are defined as meaningful only when `readOnlyHint` is false,
  so a read-only tool declares `readOnlyHint: true` and `openWorldHint: false` and stops. There is no
  `priority` hint.

## Restructure before you delete

Deleting a fact costs the answer and saves less than reshaping it.

- Ten per-category properties, each inlining the same enum, became
  `z.partialRecord(z.enum(CATEGORIES), z.enum(LEVELS))` — each enum emitted once. ~844 tokens to
  ~428, wire form unchanged, unknown keys now rejected. (Plain `z.record` is cheaper still, but marks
  every key required.)
- Hold the values as an `as const` tuple and build the schema from it, so no description restates them.

## Measure the whole wire object

```js
estimateTokens(JSON.stringify(tool)); // per tool, from a live tools/list over stdio
```

A budget over `{name, description, inputSchema}` guards a subset of the cost: it let `title`,
`annotations` and the SDK's own fields grow ~215 tokens unwatched.

**A definition is not finished until a check covers it.** Three assertions, in the gate that already
runs the server:

1. A per-tool budget, ~5% headroom, so one careless sentence fails.
2. A total under the last released figure, held as a constant. This also catches a new tool.
3. Selection keywords, one or two per tool. Clients match the words in the description, so a trim
   that saves tokens can cost discovery. Make that trade fail loudly.

Generate every published figure from the run, so a stale number fails too. Pin annotations with unit
tests; a budget with headroom will not notice a hint coming back.

## Know the floor

`$schema`, from zod's `toJSONSchema`, and `execution`, added by the SDK, cost ~90 tokens across four
tools and have no public hook. Record the floor; do not reach into SDK internals for it.

## Do not

- Merge tools to save tokens. It breaks callers, tests and clients that register by tool name, and a
  flattened schema stops saying which parameter belongs to which mode.
- Add `outputSchema` for economy. The spec asks for the payload in a text block too, so it goes twice.
