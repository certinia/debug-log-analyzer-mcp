/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  type ElicitRequest,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  authorizeExecution,
  createConfirmationLedger,
  APEX_EXECUTION_DISABLED_MESSAGE,
  type ConfirmationState,
  type ConsumeConfirmation,
  type MintConfirmationState,
  type PolicyDecision,
} from "../../src/policy/orgExecutionPolicy";
import type { OrgClassification } from "../../src/salesforce/orgClassification";

describe("authorizeExecution", () => {
  const orgLabel = "test@example.com (prod)";
  const orgId = "00D000000000001EAA";
  const apex = "System.debug('hi');";

  // The real codec, so a retry only carries state this server actually minted.
  const codec = createRequestStateCodec<ConfirmationState>({
    key: randomBytes(32),
  });

  let mintConfirmationState: jest.Mock;
  let consumeConfirmation: ConsumeConfirmation;

  function makeCtx(state?: ConfirmationState, inputResponses?: unknown) {
    return {
      mcpReq: {
        requestState: () => state,
        inputResponses,
      },
    } as unknown as ServerContext;
  }

  function authorize(
    overrides: {
      ctx?: ServerContext;
      classification?: OrgClassification;
      allowProductionOrgs?: boolean;
      apex?: string;
      orgId?: string;
      unverifiedReason?: string;
      consumeConfirmation?: ConsumeConfirmation;
    } = {},
  ) {
    return authorizeExecution({
      ctx: overrides.ctx ?? makeCtx(),
      mintConfirmationState:
        mintConfirmationState as unknown as MintConfirmationState,
      consumeConfirmation: overrides.consumeConfirmation ?? consumeConfirmation,
      classification: overrides.classification ?? "production",
      orgId: overrides.orgId ?? orgId,
      orgLabel,
      apex: overrides.apex ?? apex,
      allowProductionOrgs: overrides.allowProductionOrgs ?? false,
      unverifiedReason: overrides.unverifiedReason,
    });
  }

  /** An unknown classification always arrives with a reason from classifyOrg. */
  function authorizeUnknown(
    overrides: {
      ctx?: ServerContext;
      reason?: string;
      allowProductionOrgs?: boolean;
    } = {},
  ) {
    return authorize({
      ctx: overrides.ctx,
      classification: "unknown",
      unverifiedReason: overrides.reason ?? "inactive organization",
      allowProductionOrgs: overrides.allowProductionOrgs,
    });
  }

  function assertConfirmationRequired(
    decision: PolicyDecision,
  ): InputRequiredResult {
    expect(decision.outcome).toBe("confirmationRequired");
    if (decision.outcome !== "confirmationRequired") {
      throw new Error("expected a confirmation");
    }
    return decision.result;
  }

  function confirmRequest(result: InputRequiredResult): ElicitRequest["params"] {
    const request = result.inputRequests?.["confirm"] as
      | ElicitRequest
      | undefined;
    if (!request) {
      throw new Error("expected a 'confirm' input request");
    }
    return request.params;
  }

  /** What the SDK hands the handler on the retry: the verified payload. */
  async function verifiedState(
    result: InputRequiredResult,
  ): Promise<ConfirmationState> {
    return codec.verify(result.requestState as string, makeCtx());
  }

  /** The retry a client makes after the user answered the confirmation. */
  async function retryCtx(
    result: InputRequiredResult,
    response: unknown,
  ): Promise<ServerContext> {
    return makeCtx(await verifiedState(result), { confirm: response });
  }

  beforeEach(() => {
    mintConfirmationState = jest.fn((payload: ConfirmationState) =>
      codec.mint(payload),
    );
    consumeConfirmation = createConfirmationLedger();
  });

  describe.each<OrgClassification>(["sandbox", "scratch", "developer", "trial"])(
    "%s orgs",
    (classification) => {
      it("should be allowed without confirmation", async () => {
        await expect(authorize({ classification })).resolves.toEqual({
          outcome: "allowed",
        });
        expect(mintConfirmationState).not.toHaveBeenCalled();
      });
    },
  );

  it("should allow production when --allow-production-orgs is set", async () => {
    await expect(authorize({ allowProductionOrgs: true })).resolves.toEqual({
      outcome: "allowed",
    });
    expect(mintConfirmationState).not.toHaveBeenCalled();
  });

  it("should allow an unverifiable org when --allow-production-orgs is set", async () => {
    await expect(
      authorizeUnknown({ allowProductionOrgs: true }),
    ).resolves.toEqual({ outcome: "allowed" });
  });

  describe("the first round", () => {
    it("should ask with the org label, the Apex and a boolean schema", async () => {
      const params = confirmRequest(
        assertConfirmationRequired(await authorize()),
      );

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
    });

    it("should bind the state to the Apex and the org, not to the Apex itself", async () => {
      const result = assertConfirmationRequired(await authorize());

      const state = await verifiedState(result);
      expect(state.orgId).toBe(orgId);
      expect(state.apexDigest).toMatch(/^[0-9a-f]{64}$/);
      // Signed, not encrypted: a client can read whatever the state carries.
      expect(state.apexDigest).not.toContain("System.debug");
      expect(state.nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it("should not claim an unverifiable org is production", async () => {
      const params = confirmRequest(
        assertConfirmationRequired(await authorizeUnknown()),
      );

      expect(params.message).toContain("could not be verified");
      expect(params.message).toContain("treated as production");
      expect(params.message).toContain("Reason: inactive organization");
      expect(params.message).not.toContain("PRODUCTION org");
      const schema = params.requestedSchema as {
        properties: { confirm: { title: string } };
      };
      expect(schema.properties.confirm.title).toBe(
        `Run against org '${orgLabel}'?`,
      );
    });

    it("should truncate a long Apex snippet", async () => {
      const params = confirmRequest(
        assertConfirmationRequired(await authorize({ apex: "x".repeat(5000) })),
      );

      expect(params.message).toContain("(truncated)");
      expect(params.message.length).toBeLessThan(3000);
    });

    it("should truncate an excessively long reason", async () => {
      const params = confirmRequest(
        assertConfirmationRequired(
          await authorizeUnknown({ reason: "x".repeat(1000) }),
        ),
      );

      expect(params.message).toContain("(truncated)");
    });
  });

  describe("the retry", () => {
    it("should allow when the user confirmed", async () => {
      const result = assertConfirmationRequired(await authorize());
      const ctx = await retryCtx(result, {
        action: "accept",
        content: { confirm: true },
      });

      await expect(authorize({ ctx })).resolves.toEqual({ outcome: "allowed" });
    });

    // The signature proves the user was asked, not that the run it authorized
    // has not happened: without spending it, one answer runs the Apex as often
    // as the client re-sends the call.
    it("should refuse a confirmation that already ran", async () => {
      const result = assertConfirmationRequired(await authorize());
      const ctx = await retryCtx(result, {
        action: "accept",
        content: { confirm: true },
      });

      await expect(authorize({ ctx })).resolves.toEqual({ outcome: "allowed" });

      const decision = await authorize({ ctx });
      expect(decision).toEqual({
        outcome: "refused",
        reason: expect.stringContaining("already been used"),
      });
    });

    // Each confirmation is spent on its own, so asking again works.
    it("should allow a second run the user confirmed again", async () => {
      const first = assertConfirmationRequired(await authorize());
      await authorize({
        ctx: await retryCtx(first, {
          action: "accept",
          content: { confirm: true },
        }),
      });

      const second = assertConfirmationRequired(await authorize());
      const ctx = await retryCtx(second, {
        action: "accept",
        content: { confirm: true },
      });

      await expect(authorize({ ctx })).resolves.toEqual({ outcome: "allowed" });
    });

    it.each([
      ["decline", { action: "decline" }],
      ["cancel", { action: "cancel" }],
      [
        "accept with confirm false",
        { action: "accept", content: { confirm: false } },
      ],
      ["accept with no content", { action: "accept" }],
      [
        "accept with a non-boolean confirm",
        { action: "accept", content: { confirm: "yes" } },
      ],
    ])("should refuse on %s", async (_name, response) => {
      const result = assertConfirmationRequired(await authorize());
      const decision = await authorize({
        ctx: await retryCtx(result, response),
      });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toBe(
          `User declined the production-org execution against '${orgLabel}'.`,
        );
      }
    });

    it("should not call an unverifiable org production when the user declines", async () => {
      const result = assertConfirmationRequired(await authorizeUnknown());
      const decision = await authorizeUnknown({
        ctx: await retryCtx(result, { action: "decline" }),
      });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toBe(
          `User declined the execution against '${orgLabel}'.`,
        );
      }
    });

    it("should refuse a retry whose Apex differs from the confirmed one", async () => {
      const result = assertConfirmationRequired(await authorize());
      const ctx = await retryCtx(result, {
        action: "accept",
        content: { confirm: true },
      });

      const decision = await authorize({
        ctx,
        apex: "delete [SELECT Id FROM Account];",
      });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toContain("does not match this call");
        expect(decision.reason).toContain("nothing was executed");
      }
    });

    it("should refuse a retry aimed at a different org", async () => {
      const result = assertConfirmationRequired(await authorize());
      const ctx = await retryCtx(result, {
        action: "accept",
        content: { confirm: true },
      });

      const decision = await authorize({ ctx, orgId: "00D000000000002EAA" });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toContain("does not match this call");
      }
    });

    it("should refuse with the two enabling routes when the client carried no answer", async () => {
      const result = assertConfirmationRequired(await authorize());
      const decision = await authorize({
        ctx: makeCtx(await verifiedState(result), {}),
      });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toContain(
          `Cannot execute anonymous Apex against production org '${orgLabel}'`,
        );
        expect(decision.reason).toContain("--allow-production-orgs");
        expect(decision.reason).toContain("MCP elicitation");
      }
    });

    it("should report the reason and how to fix it when the org is unverifiable", async () => {
      const result = assertConfirmationRequired(
        await authorizeUnknown({
          reason: "Unable to refresh session due to: inactive organization",
        }),
      );
      const decision = await authorizeUnknown({
        ctx: makeCtx(await verifiedState(result), {}),
        reason: "Unable to refresh session due to: inactive organization",
      });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
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
  });

  it("should still ask when an unknown classification arrives with no reason", async () => {
    const params = confirmRequest(
      assertConfirmationRequired(await authorize({ classification: "unknown" })),
    );

    expect(params.message).toContain("could not be verified");
    expect(params.message).toContain("Reason: The reason was not reported.");
  });

  it("should ignore a stray reason on a verified production org", async () => {
    const params = confirmRequest(
      assertConfirmationRequired(
        await authorize({
          classification: "production",
          unverifiedReason: "should not appear",
        }),
      ),
    );

    expect(params.message).not.toContain("should not appear");
    expect(params.message).toContain("PRODUCTION org");
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

describe("createConfirmationLedger", () => {
  it("spends an answer once", () => {
    const consume = createConfirmationLedger();

    expect(consume("a")).toBe(true);
    expect(consume("a")).toBe(false);
    expect(consume("b")).toBe(true);
  });

  // Past the signature's own lifetime the codec refuses the state anyway, so
  // holding the nonce any longer only grows the map.
  it("forgets an answer its signature can no longer carry", () => {
    jest.useFakeTimers();
    try {
      const consume = createConfirmationLedger(600);
      expect(consume("a")).toBe(true);

      jest.advanceTimersByTime(600_000);

      expect(consume("a")).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
