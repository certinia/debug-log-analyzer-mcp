/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// A factory that throws runs only if something asks for the specifier, so this
// asserts that nothing reachable from `src/server.ts` value-imports the SDK.
jest.mock("@salesforce/core", () => {
  throw new Error("@salesforce/core was loaded from the startup graph");
});

describe("the Salesforce SDK", () => {
  /**
   * Both imports must be inside their test: a static one surfaces the throw
   * before any test runs, and reports it as a suite failure rather than here.
   *
   * `scripts/eval.mjs` covers what this cannot — the built output, and an
   * `await import("@salesforce/core")` added inside a hot path later.
   */
  it("is not loaded when the server is built", async () => {
    await expect(import("../src/server")).resolves.toBeDefined();
  });

  // Without this the test above passes whenever the mock stops being applied,
  // proving nothing and never failing.
  it("is loaded by the module that calls it", async () => {
    await expect(import("../src/salesforce/connection")).rejects.toThrow(
      "was loaded from the startup graph",
    );
  });
});
