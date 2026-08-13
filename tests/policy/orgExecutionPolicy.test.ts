/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { McpServer } from "@modelcontextprotocol/server";
import {
  authorizeExecution,
  APEX_EXECUTION_DISABLED_MESSAGE,
} from "../../src/policy/orgExecutionPolicy";
import type { OrgClassification } from "../../src/salesforce/orgClassification";

describe("authorizeExecution", () => {
  const orgLabel = "test@example.com (prod)";
  const apex = "System.debug('hi');";

  let elicitInput: jest.Mock;
  let getClientCapabilities: jest.Mock;
  let server: McpServer;
  let consoleError: jest.SpyInstance;

  function authorize(
    overrides: {
      classification?: OrgClassification;
      allowProductionOrgs?: boolean;
      apex?: string;
      unverifiedReason?: string;
    } = {},
  ) {
    return authorizeExecution({
      server,
      classification: overrides.classification ?? "production",
      orgLabel,
      apex: overrides.apex ?? apex,
      allowProductionOrgs: overrides.allowProductionOrgs ?? false,
      unverifiedReason: overrides.unverifiedReason,
    });
  }

  /** An unknown classification always arrives with a reason from classifyOrg. */
  function authorizeUnknown(
    overrides: { reason?: string; allowProductionOrgs?: boolean } = {},
  ) {
    return authorize({
      classification: "unknown",
      unverifiedReason: overrides.reason ?? "inactive organization",
      allowProductionOrgs: overrides.allowProductionOrgs,
    });
  }

  beforeEach(() => {
    elicitInput = jest.fn();
    getClientCapabilities = jest.fn(() => ({}));
    server = {
      server: { elicitInput, getClientCapabilities },
    } as unknown as McpServer;
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe.each<OrgClassification>(["sandbox", "scratch", "developer", "trial"])(
    "%s orgs",
    (classification) => {
      it("should be allowed without prompting", async () => {
        await expect(authorize({ classification })).resolves.toEqual({
          allowed: true,
        });
        expect(elicitInput).not.toHaveBeenCalled();
        expect(getClientCapabilities).not.toHaveBeenCalled();
      });
    },
  );

  it("should allow production when --allow-production-orgs is set", async () => {
    await expect(authorize({ allowProductionOrgs: true })).resolves.toEqual({
      allowed: true,
    });
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("should allow an unverifiable org when --allow-production-orgs is set", async () => {
    await expect(
      authorizeUnknown({ allowProductionOrgs: true }),
    ).resolves.toEqual({ allowed: true });
  });

  it("should refuse production when the client cannot prompt", async () => {
    const decision = await authorize();

    expect(decision.allowed).toBe(false);
    expect(elicitInput).not.toHaveBeenCalled();
    if (!decision.allowed) {
      expect(decision.reason).toContain(
        `Cannot execute anonymous Apex against production org '${orgLabel}'`,
      );
      expect(decision.reason).toContain("--allow-production-orgs");
      expect(decision.reason).toContain("MCP elicitation");
    }
  });

  it("should refuse an unverifiable org, reporting the reason and how to fix it", async () => {
    const decision = await authorizeUnknown({
      reason: "Unable to refresh session due to: inactive organization",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("could not be verified");
      expect(decision.reason).toContain("treated as production");
      // The agent needs the underlying cause to be able to act on it.
      expect(decision.reason).toContain(
        "Reason: Unable to refresh session due to: inactive organization",
      );
      expect(decision.reason).toContain("re-authenticate");
      expect(decision.reason).toContain("sf org login web");
      expect(decision.reason).toContain("--allow-production-orgs");
    }
  });

  it("should truncate an excessively long reason", async () => {
    const decision = await authorizeUnknown({ reason: "x".repeat(1000) });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("(truncated)");
      expect(decision.reason.length).toBeLessThan(800);
    }
  });

  it("should still refuse if an unknown classification arrives with no reason", async () => {
    const decision = await authorize({ classification: "unknown" });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("could not be verified");
      expect(decision.reason).toContain("Reason: The reason was not reported.");
    }
  });

  it("should ignore a stray reason on a verified production org", async () => {
    const decision = await authorize({
      classification: "production",
      unverifiedReason: "should not appear",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).not.toContain("should not appear");
      expect(decision.reason).toContain("against production org");
    }
  });

  it("should not prompt when the client only supports url elicitation", async () => {
    getClientCapabilities.mockReturnValue({ elicitation: { url: {} } });

    const decision = await authorize();

    expect(decision.allowed).toBe(false);
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("should prompt a client that declares a bare elicitation capability", async () => {
    getClientCapabilities.mockReturnValue({ elicitation: {} });
    elicitInput.mockResolvedValue({
      action: "accept",
      content: { confirm: true },
    });

    await expect(authorize()).resolves.toEqual({ allowed: true });
    expect(elicitInput).toHaveBeenCalled();
  });

  describe("with an elicitation-capable client", () => {
    beforeEach(() => {
      getClientCapabilities.mockReturnValue({ elicitation: { form: {} } });
    });

    it("should allow when the user confirms", async () => {
      elicitInput.mockResolvedValue({
        action: "accept",
        content: { confirm: true },
      });

      await expect(authorize()).resolves.toEqual({ allowed: true });
    });

    it("should prompt with the org label, the Apex and a boolean schema", async () => {
      elicitInput.mockResolvedValue({
        action: "accept",
        content: { confirm: true },
      });

      await authorize();

      const [params, options] = elicitInput.mock.calls[0];
      expect(params.message).toContain(`PRODUCTION org '${orgLabel}'`);
      expect(params.message).toContain(apex);
      expect(params.requestedSchema).toEqual({
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: `Run against production org '${orgLabel}'?`,
            description: expect.any(String),
            // Fail closed if the client pre-fills defaults.
            default: false,
          },
        },
        required: ["confirm"],
      });
      expect(options).toEqual({ timeout: 60_000 });
    });

    it("should not claim an unverifiable org is production in the prompt", async () => {
      elicitInput.mockResolvedValue({ action: "decline" });

      const decision = await authorizeUnknown({
        reason: "inactive organization",
      });

      const [params] = elicitInput.mock.calls[0];
      expect(params.message).toContain("could not be verified");
      expect(params.message).toContain("treated as production");
      expect(params.message).toContain("Reason: inactive organization");
      expect(params.message).not.toContain("PRODUCTION org");
      // Same template as production, minus the classification we cannot vouch for.
      expect(params.requestedSchema.properties.confirm.title).toBe(
        `Run against org '${orgLabel}'?`,
      );
      expect(params.requestedSchema.properties.confirm.title).not.toContain(
        "production",
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        // "the production-org execution" would be misleading here.
        expect(decision.reason).toBe(
          `User declined the execution against '${orgLabel}'.`,
        );
      }
    });

    it("should truncate a long Apex snippet in the prompt", async () => {
      elicitInput.mockResolvedValue({
        action: "accept",
        content: { confirm: true },
      });

      await authorize({ apex: "x".repeat(5000) });

      const [params] = elicitInput.mock.calls[0];
      expect(params.message).toContain("(truncated)");
      expect(params.message.length).toBeLessThan(3000);
    });

    it.each([
      ["decline", { action: "decline" }],
      ["cancel", { action: "cancel" }],
      ["accept with confirm false", { action: "accept", content: { confirm: false } }],
      ["accept with no content", { action: "accept" }],
    ])("should refuse on %s", async (_name, response) => {
      elicitInput.mockResolvedValue(response);

      const decision = await authorize();

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toContain("User declined");
        expect(decision.reason).toContain(orgLabel);
      }
    });

    it("should refuse when the prompt rejects with a non-Error", async () => {
      elicitInput.mockRejectedValue("boom");

      const decision = await authorize();

      expect(decision.allowed).toBe(false);
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), "boom");
    });

    it("should refuse with the documented error when the prompt throws", async () => {
      elicitInput.mockRejectedValue(new Error("Request timed out"));

      const decision = await authorize();

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toContain(
          "Cannot execute anonymous Apex against production org",
        );
      }
      expect(consoleError).toHaveBeenCalled();
    });
  });
});

describe("APEX_EXECUTION_DISABLED_MESSAGE", () => {
  it("should name the flag and point at the remaining tools", () => {
    expect(APEX_EXECUTION_DISABLED_MESSAGE).toContain("--no-apex-execution");
    expect(APEX_EXECUTION_DISABLED_MESSAGE).toContain(
      "log analysis tools remain available",
    );
  });
});
