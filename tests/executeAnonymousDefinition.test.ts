/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// No jest.mock in this file, which is itself the statement: what `tools/list`
// puts on the wire needs no org fakes, and no Salesforce SDK.

import {
  executeAnonymousInputSchema,
  executeAnonymousToolConfig,
} from "../src/tools/executeAnonymousDefinition";

describe("executeAnonymousToolConfig", () => {
  it("should have correct tool definition", () => {
    const config = executeAnonymousToolConfig();

    expect(config.description).toContain("Execute a snippet of anonymous Apex");
    expect(config.description).toContain("--allow-production-orgs");
    expect(config.description).not.toContain("[DISABLED");
    expect(config.annotations.destructiveHint).toBe(true);
    expect(executeAnonymousInputSchema.apex).toBeDefined();
    expect(executeAnonymousInputSchema.targetOrg).toBeDefined();
    expect(executeAnonymousInputSchema.outputDir).toBeDefined();
    expect(executeAnonymousInputSchema.debugLevel).toBeDefined();
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
    const config = executeAnonymousToolConfig(true);

    expect(config.description).toContain("[DISABLED on this server]");
    expect(config.description).toContain("--no-apex-execution");
  });
});
