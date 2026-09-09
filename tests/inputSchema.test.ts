/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { toolInputSchema } from "../src/tools/inputSchema";

describe("toolInputSchema", () => {
  const schema = toolInputSchema({
    logFilePath: z
      .string()
      .refine((value) => value.startsWith("/"), "must be an absolute path"),
    limit: z.number().int().min(0).max(1000).optional(),
  });

  // The proxy swaps one property of a real zod object, so what matters is that
  // everything else still reaches zod: a refinement, a bound and a type.
  it("validates as the zod object it wraps", () => {
    expect(schema.safeParse({ logFilePath: "/tmp/a.log" }).success).toBe(true);
    expect(schema.safeParse({ logFilePath: "a.log" }).success).toBe(false);
    expect(
      schema.safeParse({ logFilePath: "/tmp/a.log", limit: 5000 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ logFilePath: "/tmp/a.log", limit: "10" }).success,
    ).toBe(false);
  });

  it("states the properties but not the dialect", () => {
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });

    expect(json.$schema).toBeUndefined();
    expect(json).toMatchObject({
      type: "object",
      properties: { logFilePath: { type: "string" } },
      required: ["logFilePath"],
    });
  });
});
