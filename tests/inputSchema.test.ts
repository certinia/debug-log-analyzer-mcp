/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { listSlowOperationsTool } from "../src/tools/listSlowOperations";

// The shipped schema, because it is the one that has to survive the wrapper: a
// refinement (`logFilePath`), a floor and an integer (`limit`), and an enum.
const schema = listSlowOperationsTool.config.inputSchema;
const logFilePath = "/tmp/a.log";

describe("toolInputSchema", () => {
  it("validates as the zod object it wraps", () => {
    expect(schema.safeParse({ logFilePath }).success).toBe(true);
    expect(schema.safeParse({ logFilePath: "a.log" }).success).toBe(false);
    expect(schema.safeParse({ logFilePath, limit: -1 }).success).toBe(false);
    expect(schema.safeParse({ logFilePath, limit: "10" }).success).toBe(false);
    expect(schema.safeParse({ logFilePath, groupBy: "nope" }).success).toBe(
      false,
    );
  });

  it("refuses a parameter the tool does not have, at no cost on the wire", () => {
    const result = schema.safeParse({ logFilePath, eventType: ["USER_DEBUG"] });
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });

    expect(result.error?.issues[0]?.message).toBe('Unrecognized key: "eventType"');
    expect(json).not.toHaveProperty("additionalProperties");
  });

  // The safe-integer bound is dropped where the figure is zod's, and kept where
  // the field asked for it - `limit` states `.min(0)`, and 0 reaches the wire.
  it("drops what only zod reads, at any depth", () => {
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    const limit = (json.properties as Record<string, Record<string, unknown>>)
      .limit;

    expect(json.$schema).toBeUndefined();
    expect(limit).toEqual({
      description: expect.stringContaining("Page size"),
      type: "integer",
      minimum: 0,
    });
    expect(JSON.stringify(json)).not.toContain("9007199254740991");
  });
});
