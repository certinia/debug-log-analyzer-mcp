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
  authorizeOperation,
  createConfirmationLedger,
  APEX_EXECUTION_DISABLED_MESSAGE,
  type Confirmable,
  type ConfirmationState,
  type ConsumeConfirmation,
  type MintConfirmationState,
  type PolicyDecision,
} from "../../src/policy/orgExecutionPolicy";
import type { OrgClassification } from "../../src/salesforce/orgClassification";

describe("authorizeOperation", () => {
  const orgLabel = "test@example.com (prod)";
  const orgId = "00D000000000001EAA";
  const tool = "apexlog_test_tool";
  const action = "delete 3 debug logs";
  const confirm: Confirmable = {
    effect: "07L000000000001,07L000000000002,07L000000000003",
    detail: "Debug logs: 07L000000000001, 07L000000000002, 07L000000000003",
    title: "Delete 3 debug logs",
  };

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
      tool?: string;
      confirm?: Confirmable;
      orgId?: string;
      unverifiedReason?: string;
      consumeConfirmation?: ConsumeConfirmation;
    } = {},
  ) {
    return authorizeOperation({
      ctx: overrides.ctx ?? makeCtx(),
      mintConfirmationState:
        mintConfirmationState as unknown as MintConfirmationState,
      consumeConfirmation: overrides.consumeConfirmation ?? consumeConfirmation,
      classification: overrides.classification ?? "production",
      orgId: overrides.orgId ?? orgId,
      orgLabel,
      allowProductionOrgs: overrides.allowProductionOrgs ?? false,
      unverifiedReason: overrides.unverifiedReason,
      tool: overrides.tool ?? tool,
      action,
      confirm: overrides.confirm ?? confirm,
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
    it("should ask with the action, the org label, the detail and a boolean schema", async () => {
      const params = confirmRequest(
        assertConfirmationRequired(await authorize()),
      );

      expect(params.message).toBe(
        `About to ${action} against PRODUCTION org '${orgLabel}'.\n\n${confirm.detail}\n\nProceed?`,
      );
      expect(params.requestedSchema).toEqual({
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: `${confirm.title} against production org '${orgLabel}'?`,
            description: expect.any(String),
            // Fail closed if the client pre-fills defaults.
            default: false,
          },
        },
        required: ["confirm"],
      });
    });

    it("should bind the state to the tool, the effect and the org, not to the effect itself", async () => {
      const result = assertConfirmationRequired(await authorize());

      const state = await verifiedState(result);
      expect(state.tool).toBe(tool);
      expect(state.orgId).toBe(orgId);
      expect(state.effectDigest).toMatch(/^[0-9a-f]{64}$/);
      // Signed, not encrypted: a client can read whatever the state carries.
      expect(state.effectDigest).not.toContain("07L");
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
        `${confirm.title} against org '${orgLabel}'?`,
      );
    });

    it("should refuse, not ask, when the write cannot be shown whole", async () => {
      const unshowable = "Too long to show, so nothing was done.";

      await expect(
        authorize({ confirm: { ...confirm, unshowable } }),
      ).resolves.toEqual({ outcome: "refused", reason: unshowable });
      expect(mintConfirmationState).not.toHaveBeenCalled();
    });

    it.each<[string, { classification?: OrgClassification; allowProductionOrgs?: boolean }]>([
      ["with --allow-production-orgs", { allowProductionOrgs: true }],
      ["on a sandbox", { classification: "sandbox" }],
    ])("should allow a write that cannot be shown whole %s", async (_name, overrides) => {
      await expect(
        authorize({ ...overrides, confirm: { ...confirm, unshowable: "x" } }),
      ).resolves.toEqual({ outcome: "allowed" });
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

    // The signature proves the user was asked, not that the call it authorized
    // has not happened: without spending it, one answer does the write as often
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
        reason: expect.stringContaining("already used"),
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
          `User declined to ${action} against production org '${orgLabel}'. Do not retry unless the user asks.`,
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
          `User declined to ${action} against org '${orgLabel}'. Do not retry unless the user asks.`,
        );
      }
    });

    it("should refuse a retry whose effect differs from the confirmed one", async () => {
      const result = assertConfirmationRequired(await authorize());
      const ctx = await retryCtx(result, {
        action: "accept",
        content: { confirm: true },
      });

      const decision = await authorize({
        ctx,
        confirm: { ...confirm, effect: "07L000000000009" },
      });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toContain("does not match this call");
        expect(decision.reason).toContain("nothing was done");
        expect(decision.reason).toContain("Call the tool again for a new confirmation.");
      }
    });

    // Every tool is called through tools/call, so the codec's method binding cannot tell them apart.
    it("should refuse a confirmation given for another tool", async () => {
      const result = assertConfirmationRequired(
        await authorize({ tool: "apexlog_other_tool" }),
      );
      const ctx = await retryCtx(result, {
        action: "accept",
        content: { confirm: true },
      });

      const decision = await authorize({ ctx });

      expect(decision.outcome).toBe("refused");
      if (decision.outcome === "refused") {
        expect(decision.reason).toContain("does not match this call");
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
          `Cannot ${action} against production org '${orgLabel}'`,
        );
        expect(decision.reason).toContain("--allow-production-orgs");
        expect(decision.reason).toContain("the user must restart");
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
