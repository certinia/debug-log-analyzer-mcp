/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";

/**
 * A tool's input schema, as the wire wants it: zod for validation, and no
 * `$schema`.
 *
 * `z.toJSONSchema` states the dialect it emitted - 14 tokens a tool, charged on
 * every request - and MCP fixes the dialect for a tool's `inputSchema`, so no
 * client reads it. The SDK converts through the schema's own
 * `~standard.jsonSchema`, which is a documented interface, so a proxy that swaps
 * that one property leaves the real zod object doing the validating.
 *
 * Wrapping also takes the four tools off `registerTool`'s raw-shape overload,
 * which the SDK deprecates in favour of `z.object`.
 */
export function toolInputSchema<S extends z.ZodRawShape>(
  shape: S,
): z.ZodObject<S> {
  const object = z.object(shape);
  const { jsonSchema, ...rest } = object["~standard"];
  // A zod that no longer publishes the converter is one the SDK falls back to
  // `z.toJSONSchema` for, and a saving of 14 tokens is not worth trading that
  // fallback for a TypeError at import, which would take all four tools with it.
  if (jsonSchema === undefined) {
    return object;
  }
  const withoutDialect = (
    convert: (options: Parameters<typeof jsonSchema.input>[0]) => Record<string, unknown>,
  ) => (options: Parameters<typeof jsonSchema.input>[0]) => {
    const { $schema: _dialect, ...schema } = convert(options);
    return schema;
  };
  const standard = {
    ...rest,
    jsonSchema: {
      input: withoutDialect(jsonSchema.input),
      output: withoutDialect(jsonSchema.output),
    },
  };

  return new Proxy(object, {
    get: (target, property, receiver) =>
      property === "~standard"
        ? standard
        : Reflect.get(target, property, receiver),
  });
}
