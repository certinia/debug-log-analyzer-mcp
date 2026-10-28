/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("../../src/salesforce/connection", () => ({
  readLocalOrg: jest.fn(),
  connectOrg: jest.fn(),
}));

jest.mock("../../src/salesforce/orgClassification", () => ({
  ...jest.requireActual("../../src/salesforce/orgClassification"),
  classifyOrg: jest.fn(),
}));

import { randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  SdkError,
  SdkErrorCode,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { AuthInfo, Org } from "@salesforce/core";
import {
  bindOpenOrg,
  type OrgAccess,
  type OrgAccessPolicy,
  type OrgRequest,
} from "../../src/salesforce/orgAccess";
import {
  connectOrg,
  readLocalOrg,
  type LocalOrg,
} from "../../src/salesforce/connection";
import {
  classifyOrg,
  type OrgClassification,
} from "../../src/salesforce/orgClassification";
import { compileDenyList } from "../../src/policy/orgDenyList";
import {
  createConfirmationLedger,
  type Confirmable,
  type ConfirmationState,
} from "../../src/policy/orgExecutionPolicy";

const mockReadLocalOrg = readLocalOrg as jest.MockedFunction<
  typeof readLocalOrg
>;
const mockConnectOrg = connectOrg as jest.MockedFunction<typeof connectOrg>;
const mockClassifyOrg = classifyOrg as jest.MockedFunction<typeof classifyOrg>;

const LOCAL_ORG: LocalOrg = {
  orgId: "00D000000000001",
  username: "test@example.com",
  aliases: ["psa"],
  instanceUrl: "https://example.my.salesforce.com",
  authInfo: {} as AuthInfo,
};

const CONFIRM: Confirmable = {
  effect: "07L000000000001",
  detail: "Debug log 07L000000000001",
  title: "Delete 1 debug log",
};

const codec = createRequestStateCodec<ConfirmationState>({
  key: randomBytes(32),
});

const connection = { tag: "connection" };

let listRoots: jest.Mock;
let mintConfirmationState: jest.Mock;

function server(): McpServer {
  return { server: { listRoots } } as unknown as McpServer;
}

function makeCtx(state?: ConfirmationState, inputResponses?: unknown) {
  return {
    mcpReq: {
      signal: new AbortController().signal,
      requestState: () => state,
      inputResponses,
    },
  } as unknown as ServerContext;
}

function policy(overrides: Partial<OrgAccessPolicy> = {}): OrgAccessPolicy {
  return {
    allowProductionOrgs: false,
    denyList: compileDenyList([]),
    classificationCache: new Map<string, OrgClassification>(),
    mintConfirmationState,
    consumeConfirmation: createConfirmationLedger(),
    ...overrides,
  };
}

function request<T, V = T>(
  overrides: Partial<OrgRequest<T, V>> = {},
): OrgRequest<T, V> {
  return {
    action: "delete 1 debug log",
    targetOrg: "psa",
    write: false,
    ...overrides,
  };
}

const write = {
  write: async ({ value }: { value: undefined }) => ({ value, confirm: CONFIRM }),
};

function refusalText(access: OrgAccess<unknown>): string {
  if (access.granted) {
    throw new Error("expected a refusal");
  }
  const result = access.result as { isError?: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

function inputRequired(access: OrgAccess<unknown>): InputRequiredResult {
  if (access.granted) {
    throw new Error("expected a confirmation");
  }
  const result = access.result as InputRequiredResult;
  expect(result.resultType).toBe("input_required");
  return result;
}

function classifyAs(classification: OrgClassification): void {
  mockClassifyOrg.mockResolvedValue({ classification });
}

/** One call's `open`, as the server binds it, for the tool named `tool`. */
function open<T, V = T>(
  mcpServer: McpServer,
  ctx: ServerContext,
  orgRequest: OrgRequest<T, V>,
  accessPolicy: OrgAccessPolicy,
  tool = "apexlog_test_tool",
): Promise<OrgAccess<V>> {
  return bindOpenOrg(mcpServer, ctx, tool, accessPolicy)(orgRequest);
}

describe("openOrg", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listRoots = jest
      .fn()
      .mockResolvedValue({ roots: [{ uri: "file:///home/me/project" }] });
    mintConfirmationState = jest.fn((payload: ConfirmationState) =>
      codec.mint(payload),
    );
    mockReadLocalOrg.mockResolvedValue(LOCAL_ORG);
    mockConnectOrg.mockResolvedValue({
      getConnection: () => connection,
    } as unknown as Org);
    classifyAs("sandbox");
  });

  it("should grant a sandbox with the prepared value, the connection and the roots", async () => {
    const access = await open(
      server(),
      makeCtx(),
      request({ prepare: async (rootPaths) => `read in ${rootPaths.join()}` }),
      policy(),
    );

    expect(access).toMatchObject({
      granted: true,
      value: "read in /home/me/project",
      connection,
      orgLabel: "test@example.com (psa)",
      classification: "sandbox",
      rootPaths: ["/home/me/project"],
    });
    expect(mockReadLocalOrg).toHaveBeenCalledWith("/home/me/project", "psa");
  });

  it("should let a write go ahead on a sandbox without asking", async () => {
    const access = await open(server(), makeCtx(), request(write), policy());

    expect(access.granted).toBe(true);
    expect(mintConfirmationState).not.toHaveBeenCalled();
  });

  // So a write can read the org, e.g. count what it will delete, before it asks.
  it("should build the confirmation after connecting, from the prepared value", async () => {
    classifyAs("production");
    const write = jest.fn(
      async ({ value, orgLabel }: { value: string; orgLabel: string }) => {
        expect(mockConnectOrg).toHaveBeenCalled();
        return {
          value,
          confirm: { ...CONFIRM, detail: `${value} on ${orgLabel}` },
        };
      },
    );

    const result = inputRequired(
      await open(
        server(),
        makeCtx(),
        request({ prepare: async () => "3 logs", write }),
        policy(),
      ),
    );

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ value: "3 logs", connection, local: LOCAL_ORG }),
    );
    expect(JSON.stringify(result.inputRequests)).toContain(
      "3 logs on test@example.com (psa)",
    );
  });

  // So the write does exactly what it read and confirmed, e.g. the log ids it counted.
  it("should grant the value the write planned", async () => {
    const access = await open(
      server(),
      makeCtx(),
      request({
        prepare: async () => "filter",
        write: async ({ value }) => ({
          value: { filter: value, ids: ["07L1", "07L2"] },
          confirm: CONFIRM,
        }),
      }),
      policy(),
    );

    expect(access).toMatchObject({
      granted: true,
      value: { filter: "filter", ids: ["07L1", "07L2"] },
    });
  });

  it("should report the connect step before it connects", async () => {
    const report = jest.fn(async () => {
      expect(mockConnectOrg).not.toHaveBeenCalled();
    });

    await open(server(), makeCtx(), request({ report }), policy());

    expect(report).toHaveBeenCalledWith("Connecting to the org");
  });

  // Org.create can call the org, and prepare may read a file the org never needs.
  it("should refuse a denied identity before prepare and before connecting", async () => {
    const prepare = jest.fn();

    const access = await open(
      server(),
      makeCtx(),
      request({ prepare }),
      policy({ denyList: compileDenyList(["psa"]) }),
    );

    expect(refusalText(access)).toContain(
      "Cannot delete 1 debug log against org 'test@example.com (psa)': it matches the --deny-orgs entry 'psa'",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(mockConnectOrg).not.toHaveBeenCalled();
  });

  // A refusal, not a confirmation: no answer can lift a deny.
  it("should refuse a denied type before a write can ask", async () => {
    classifyAs("production");

    const access = await open(
      server(),
      makeCtx(),
      request(write),
      policy({ denyList: compileDenyList(["type:production"]) }),
    );

    expect(refusalText(access)).toContain(
      "--deny-orgs entry 'type:production'",
    );
    expect(mintConfirmationState).not.toHaveBeenCalled();
  });

  it("should grant a read against production without asking", async () => {
    classifyAs("production");

    const access = await open(server(), makeCtx(), request(), policy());

    expect(access.granted).toBe(true);
    expect(mintConfirmationState).not.toHaveBeenCalled();
  });

  it("should ask before a write against production", async () => {
    classifyAs("production");
    const result = inputRequired(
      await open(server(), makeCtx(), request(write), policy()),
    );

    expect(mintConfirmationState).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "apexlog_test_tool" }),
      expect.anything(),
    );
    expect(typeof result.requestState).toBe("string");
  });

  it("should let a production write go ahead without asking when production orgs are allowed", async () => {
    classifyAs("production");

    const access = await open(
      server(),
      makeCtx(),
      request(write),
      policy({ allowProductionOrgs: true }),
    );

    expect(access.granted).toBe(true);
    expect(mintConfirmationState).not.toHaveBeenCalled();
  });

  it("should not ask about a write that found nothing to change", async () => {
    classifyAs("production");

    const access = await open(
      server(),
      makeCtx(),
      request({ write: async () => ({ value: "nothing", confirm: null }) }),
      policy(),
    );

    expect(access).toMatchObject({ granted: true, value: "nothing" });
    expect(mintConfirmationState).not.toHaveBeenCalled();
  });

  it("should refuse a confirmation given for another tool", async () => {
    classifyAs("production");
    const asked = inputRequired(
      await open(
        server(),
        makeCtx(),
        request(write),
        policy(),
        "apexlog_other_tool",
      ),
    );
    const state = await codec.verify(asked.requestState as string, makeCtx());

    const access = await open(
      server(),
      makeCtx(state, {
        confirm: { action: "accept", content: {} },
      }),
      request(write),
      policy(),
    );

    expect(refusalText(access)).toContain("does not match this call");
  });

  describe("when the client's roots cannot be used", () => {
    beforeEach(() => {
      listRoots.mockRejectedValue(
        new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
      );
    });

    it("should refuse a call that names no org, before reading the local org", async () => {
      const access = await open(
        server(),
        makeCtx(),
        request({ targetOrg: undefined }),
        policy(),
      );

      expect(refusalText(access)).toBe(
        "Cannot tell which project's default org to use: the client's roots could not be read: Request timed out. Pass targetOrg.",
      );
      expect(mockReadLocalOrg).not.toHaveBeenCalled();
    });

    it("should refuse on an empty refusal rather than fall through", async () => {
      const access = await open(
        server(),
        makeCtx(),
        request({ targetOrg: undefined, unknownRoots: () => "" }),
        policy(),
      );

      expect(access.granted).toBe(false);
      expect(mockReadLocalOrg).not.toHaveBeenCalled();
    });

    it("should return the tool's own refusal first", async () => {
      const access = await open(
        server(),
        makeCtx(),
        request({ unknownRoots: (reason) => `No file check: ${reason}` }),
        policy(),
      );

      expect(refusalText(access)).toBe(
        "No file check: the client's roots could not be read: Request timed out",
      );
      expect(mockReadLocalOrg).not.toHaveBeenCalled();
    });

    it("should grant a named org, with the workspace marked unknown", async () => {
      const access = await open(server(), makeCtx(), request(), policy());

      expect(access).toMatchObject({
        granted: true,
        workspace: { kind: "unknown" },
        rootPaths: [],
      });
      expect(mockReadLocalOrg).toHaveBeenCalledWith(undefined, "psa");
    });
  });

  it("should use the cwd's project when the client declares no roots", async () => {
    listRoots.mockRejectedValue(
      new SdkError(SdkErrorCode.CapabilityNotSupported, "no roots"),
    );

    const access = await open(
      server(),
      makeCtx(),
      request({ targetOrg: undefined }),
      policy(),
    );

    expect(access).toMatchObject({ granted: true, workspace: { kind: "none" } });
    expect(mockReadLocalOrg).toHaveBeenCalledWith(undefined, undefined);
  });

  it("should take a 2026-07-28 client that declared no roots as having none", async () => {
    listRoots.mockRejectedValue(
      new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, "not on 2026-07-28"),
    );
    const ctx = {
      mcpReq: {
        ...makeCtx().mcpReq,
        envelope: { [CLIENT_CAPABILITIES_META_KEY]: {} },
      },
    } as unknown as ServerContext;

    const access = await open(server(), ctx, request(), policy());

    expect(access).toMatchObject({ granted: true, workspace: { kind: "none" } });
  });

  // Bounded, so a client that never answers costs seconds; the signal, so a cancel ends the wait.
  it("should wait a bounded time for the roots, on the call's own signal", async () => {
    const ctx = makeCtx();

    await open(server(), ctx, request(), policy());

    expect(listRoots).toHaveBeenCalledWith(undefined, {
      timeout: 5_000,
      signal: ctx.mcpReq.signal,
    });
  });

  it("should stop a cancelled call, not run on as if the roots were unreadable", async () => {
    // An SdkError, which the switch below the abort check would otherwise read as no roots.
    listRoots.mockRejectedValue(
      new SdkError(SdkErrorCode.CapabilityNotSupported, "aborted"),
    );
    const controller = new AbortController();
    controller.abort();
    const ctx = {
      mcpReq: { ...makeCtx().mcpReq, signal: controller.signal },
    } as unknown as ServerContext;

    await expect(open(server(), ctx, request(), policy())).rejects.toThrow("aborted");
    expect(mockReadLocalOrg).not.toHaveBeenCalled();
  });

  it("should connect to the org it checked, through the same auth", async () => {
    await open(server(), makeCtx(), request(), policy());

    expect(mockConnectOrg).toHaveBeenCalledWith(LOCAL_ORG);
  });

  it("should throw a connect fault, not refuse, and plan no write", async () => {
    mockConnectOrg.mockRejectedValue(new Error("No default org is set."));
    const plan = jest.fn();

    await expect(
      open(server(), makeCtx(), request({ write: plan }), policy()),
    ).rejects.toThrow("No default org is set.");
    expect(plan).not.toHaveBeenCalled();
  });

  it("should classify against the policy's cache, so one org is classified once", async () => {
    const classificationCache = new Map<string, OrgClassification>();

    await open(server(), makeCtx(), request(), policy({ classificationCache }));

    // The same Map, not an equal one: an empty Map equals any other.
    expect(mockClassifyOrg.mock.calls[0]?.[1]).toBe(classificationCache);
  });

  // The reason has to reach the person, so the agent can suggest a new login.
  it("should ask about an org it could not verify, and say why", async () => {
    mockClassifyOrg.mockResolvedValue({
      classification: "unknown",
      unverifiedReason: "Unable to refresh session due to: inactive organization",
    });

    const result = inputRequired(
      await open(server(), makeCtx(), request(write), policy()),
    );

    // The reason only: its framing is orgExecutionPolicy.test's.
    expect(JSON.stringify(result)).toContain(
      "Unable to refresh session due to: inactive organization",
    );
  });
});
