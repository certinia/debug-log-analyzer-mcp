/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// No jest.mock in this file, which is itself the statement: what `tools/list`
// puts on the wire needs no org fakes, and no Salesforce SDK.

import {
  executeAnonymousInputSchema,
  executeAnonymousTool,
} from "../src/tools/executeAnonymousDefinition";
import { APEX_EXECUTION_DISABLED_MESSAGE } from "../src/policy/orgExecutionPolicy";

describe("executeAnonymousTool", () => {
  it("should have correct tool definition", () => {
    const { config } = executeAnonymousTool();

    expect(config.description).toContain("Execute anonymous Apex");
    // Who it runs as decides what it can see; the production gate is in the server instructions.
    expect(config.description).toContain("as the targetOrg user");
    expect(config.description).not.toContain("[DISABLED");
    expect(config.annotations.destructiveHint).toBe(true);
  });

  it("should accept the three debugLevel forms and reject an unknown category", () => {
    const debugLevel = executeAnonymousInputSchema.debugLevel;

    expect(debugLevel.safeParse("default").success).toBe(true);
    expect(debugLevel.safeParse("FINEST").success).toBe(true);
    expect(
      debugLevel.safeParse({ apexCode: "FINEST", database: "NONE" }).success,
    ).toBe(true);

    expect(debugLevel.safeParse("LOUDEST").success).toBe(false);
    expect(debugLevel.safeParse({ apexCode: "LOUDEST" }).success).toBe(false);
    expect(debugLevel.safeParse({ notACategory: "FINE" }).success).toBe(false);
  });

  it("should flag the tool as disabled in its description when execution is off", () => {
    const { config } = executeAnonymousTool(APEX_EXECUTION_DISABLED_MESSAGE);

    expect(config.description).toContain("[DISABLED on this server]");
    expect(config.description).toContain("--no-apex-execution");
  });
});
