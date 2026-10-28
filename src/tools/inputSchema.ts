/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { LOG_LEVELS, TRACE_CATEGORIES } from "../logLevels.js";
import { DEFAULT_OUTPUT_DIR } from "./logStore.js";

/** The org an org tool runs against, worded once so every tool charges the same tokens for it. */
export const targetOrgSchema = z
  .string()
  .optional()
  .describe(
    "Alias or username of the target Salesforce org. Uses the project default if not specified.",
  );

/** Where an org tool saves a log, worded once like `targetOrgSchema`. */
export const outputDirSchema = z
  .string()
  .optional()
  .describe(
    `Log directory (default: ${DEFAULT_OUTPUT_DIR}/ in the first client root, else cwd)`,
  );

/** Levels for the categories named; each tool's description says what the rest get. */
export const levelsByCategorySchema = z.partialRecord(
  z.enum(TRACE_CATEGORIES),
  z.enum(LOG_LEVELS),
);

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
): z.ZodObject<S, z.core.$strict> {
  // Strict, so a misnamed parameter is refused rather than dropped and the call run unfiltered.
  return leanOnTheWire(z.strictObject(shape));
}

/**
 * The input schema of a tool this server refuses every call to: no parameters
 * on the wire, where the full schema costs hundreds of tokens on every request,
 * and any arguments accepted, so a call the agent shaped from the description
 * gets the refusal and not a validation error.
 */
export function refusedInputSchema(): z.ZodObject<Record<never, never>, z.core.$loose> {
  return leanOnTheWire(z.looseObject({}));
}

function leanOnTheWire<O extends z.ZodObject>(object: O): O {
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
      input: (options) => withoutStrictness(withoutUnread(standard.jsonSchema.input(options))),
    },
  };

  return object;
}

// zod refuses an unknown key itself; saying so on the wire costs tokens on every request. Top level only: a record's is its value schema.
function withoutStrictness(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties, ...rest } = schema;
  return additionalProperties === false ? rest : schema;
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
