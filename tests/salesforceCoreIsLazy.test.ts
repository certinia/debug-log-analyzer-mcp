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
   * The import must be inside the test: a static one surfaces the throw before
   * any test runs, and reports it as a suite failure rather than this one.
   *
   * What this does not prove: anything about `dist/`, and anything about an
   * `await import("@salesforce/core")` added inside a hot path later. The
   * measurement in the pull request covers the built output.
   */
  it("is not loaded when the server is built", async () => {
    await expect(import("../src/server")).resolves.toBeDefined();
  });
});
