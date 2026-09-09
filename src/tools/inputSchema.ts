/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";

/** What zod states and no client reads, where the value is zod's and not ours. */
const UNREAD = new Set(["$schema", "minimum", "maximum"]);

/**
 * A tool's input schema, as the wire wants it: zod for validation, and none of
 * what zod says to itself.
 *
 * `$schema` names the dialect zod converted to, 14 tokens a tool, and MCP fixes
 * the dialect for a tool's `inputSchema`. `minimum` and `maximum` at the
 * safe-integer bound are what `.int()` emits where the field states no bound of
 * its own, and they describe the double, not the parameter. Both are charged on
 * every request.
 *
 * Neither is reachable through zod: `$ZodConfig` has no JSON Schema knob, and
 * `z.toJSONSchema` derives the dialect from the target alone. The SDK converts
 * through the schema's own `~standard.jsonSchema`, so replacing that one
 * property leaves the real zod object doing the validating - it keeps its
 * refinements, its bounds and its type. `fromJsonSchema` would put an exact
 * document on the wire, but it validates through JSON Schema, which would drop
 * both the refinements and the inferred argument types.
 *
 * Wrapping also takes the four tools off `registerTool`'s raw-shape overload,
 * which the SDK deprecates in favour of `z.object`.
 */
export function toolInputSchema<S extends z.ZodRawShape>(
  shape: S,
): z.ZodObject<S> {
  const object = z.object(shape);
  const standard = object["~standard"];
  // A zod that no longer publishes the converter is one the SDK falls back to
  // `z.toJSONSchema` for, and 14 tokens are not worth trading that for a throw
  // at import, which would take every tool with it.
  if (standard.jsonSchema === undefined) {
    return object;
  }

  object["~standard"] = {
    ...standard,
    jsonSchema: {
      ...standard.jsonSchema,
      input: (options) => withoutUnread(standard.jsonSchema.input(options)),
    },
  };

  return object;
}

/**
 * The document without the keywords above, at any depth.
 *
 * Recursive over values rather than over the keywords that nest, because the
 * bound belongs to the number: an `.int()` inside an array or a record states it
 * a level down, where a pass over the top-level properties reads nothing.
 */
function withoutUnread(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([keyword, value]) => !isUnread(keyword, value))
      .map(([keyword, value]) => [keyword, prune(value)]),
  );
}

function isUnread(keyword: string, value: unknown): boolean {
  if (!UNREAD.has(keyword)) {
    return false;
  }
  // `$schema` is ours to drop whatever it says; a bound only where the figure is
  // the double's, not one the field asked for.
  return (
    keyword === "$schema" ||
    (typeof value === "number" && Math.abs(value) === Number.MAX_SAFE_INTEGER)
  );
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune);
  }
  if (typeof value === "object" && value !== null) {
    return withoutUnread(value as Record<string, unknown>);
  }
  return value;
}
