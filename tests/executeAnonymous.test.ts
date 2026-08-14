/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("node:fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue({ size: 1024 }),
    // No symlinks in the test filesystem, so every path resolves to itself.
    realpath: jest.fn((target: string) => Promise.resolve(target)),
  },
}));

jest.mock("../src/salesforce/users", () => ({
  getUserIdByUsername: jest.fn(),
}));

// Only the network call is mocked — LOG_LEVELS and TRACE_CATEGORIES are the
// real ones, because the input schema is built from them at import time.
jest.mock("../src/salesforce/debugLevels", () => ({
  ...jest.requireActual("../src/salesforce/debugLevels"),
  getOrCreateDebugLevelId: jest.fn(),
}));

jest.mock("../src/salesforce/traceFlags", () => ({
  ensureTraceFlag: jest.fn(),
}));

jest.mock("../src/salesforce/connection", () => ({
  resolveOrg: jest.fn(),
}));

jest.mock("@salesforce/core", () => {
  const actual = jest.requireActual("@salesforce/core");
  return {
    ...actual,
    ConfigAggregator: {
      create: jest.fn(),
    },
    StateAggregator: {
      getInstance: jest.fn(),
    },
  };
});

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  McpServer,
  type ElicitRequest,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { ConfigAggregator, StateAggregator } from "@salesforce/core";
import { decode } from "@toon-format/toon";
import {
  executeAnonymous,
  ExecuteAnonymousArgs,
} from "../src/tools/executeAnonymous";
import { getUserIdByUsername } from "../src/salesforce/users";
import { getOrCreateDebugLevelId } from "../src/salesforce/debugLevels";
import { ensureTraceFlag } from "../src/salesforce/traceFlags";
import { resolveOrg } from "../src/salesforce/connection";
import type { OrgClassification } from "../src/salesforce/orgClassification";
import type { ConfirmationState } from "../src/policy/orgExecutionPolicy";

const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockStat = fs.stat as jest.MockedFunction<typeof fs.stat>;

const mockResolveOrg = resolveOrg as jest.MockedFunction<typeof resolveOrg>;
const mockConfigAggregatorCreate = ConfigAggregator.create as jest.Mock;
const mockStateAggregatorGetInstance = StateAggregator.getInstance as jest.Mock;

const SANDBOX_ORG_INFO = {
  Name: "Test",
  InstanceName: "CS1",
  IsSandbox: true,
  TrialExpirationDate: null,
  NamespacePrefix: null,
  OrganizationType: "Enterprise Edition",
};

const PRODUCTION_ORG_INFO = { ...SANDBOX_ORG_INFO, IsSandbox: false };

// The real codec, so a retried call only carries state this server minted.
const codec = createRequestStateCodec<ConfirmationState>({
  key: randomBytes(32),
});

function policy(
  overrides: {
    allowProductionOrgs?: boolean;
    apexExecutionDisabled?: boolean;
    classificationCache?: Map<string, OrgClassification>;
  } = {},
) {
  return {
    allowProductionOrgs: false,
    apexExecutionDisabled: false,
    classificationCache: new Map<string, OrgClassification>(),
    mintConfirmationState: (payload: ConfirmationState) => codec.mint(payload),
    ...overrides,
  };
}

/** A call carrying no confirmation: the first round of any flow. */
function makeCtx(state?: ConfirmationState, inputResponses?: unknown) {
  return {
    mcpReq: {
      requestState: () => state,
      inputResponses,
    },
  } as unknown as ServerContext;
}

describe("Execute Anonymous", () => {
  const testUserId = "005000000000001";
  const testDebugLevelId = "07L000000000001";
  const testLogId = "07L000000000002";
  const testLogBody = "APEX DEBUG LOG CONTENT HERE";
  const testApexCode = "System.debug('Hello World');";

  let mockServer: McpServer;
  let mockConnection: any;
  let mockTooling: any;
  let mockExecuteAnonymous: any;
  let mockRequest: any;
  let mockGetUsername: any;
  let mockSobject: any;
  let mockFindOne: any;
  let mockOrg: any;
  let mockRetrieveOrgInfo: jest.Mock;
  let ctx: ServerContext;

  beforeEach(() => {
    jest.clearAllMocks();

    ctx = makeCtx();

    mockServer = {
      server: {
        listRoots: jest.fn().mockResolvedValue({ roots: [] }),
      },
    } as unknown as McpServer;

    mockExecuteAnonymous = jest.fn();
    mockRequest = jest.fn();
    mockGetUsername = jest.fn().mockReturnValue("test@example.com");

    mockFindOne = jest.fn();
    mockSobject = jest.fn().mockReturnValue({ findOne: mockFindOne });

    mockTooling = {
      executeAnonymous: mockExecuteAnonymous,
    };

    mockConnection = {
      tooling: mockTooling,
      sobject: mockSobject,
      request: mockRequest,
      getUsername: mockGetUsername,
      userInfo: {
        id: testUserId,
      },
    };

    mockRetrieveOrgInfo = jest.fn().mockResolvedValue(SANDBOX_ORG_INFO);
    mockOrg = {
      getConnection: jest.fn(() => mockConnection),
      getOrgId: jest.fn(() => "00D000000000001"),
      retrieveOrganizationInformation: mockRetrieveOrgInfo,
    };

    mockResolveOrg.mockResolvedValue(mockOrg);

    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: {
        resolveUsername: jest.fn((input: string) => input),
        get: jest.fn(() => null),
      },
    });

    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: jest.fn(() => undefined),
    });

    (
      getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>
    ).mockResolvedValue(testUserId);
    (
      getOrCreateDebugLevelId as jest.MockedFunction<
        typeof getOrCreateDebugLevelId
      >
    ).mockResolvedValue(testDebugLevelId);
    (
      ensureTraceFlag as jest.MockedFunction<typeof ensureTraceFlag>
    ).mockResolvedValue();
  });

  describe("executeAnonymous", () => {
    it("should successfully execute Apex and return log", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(getUserIdByUsername).toHaveBeenCalledWith(
        mockConnection,
        "test@example.com",
      );
      expect(getOrCreateDebugLevelId).toHaveBeenCalledWith(
        mockConnection,
        undefined,
      );
      expect(ensureTraceFlag).toHaveBeenCalledWith(
        mockConnection,
        testUserId,
        testDebugLevelId,
      );
      expect(mockExecuteAnonymous).toHaveBeenCalledWith(testApexCode);
      expect(mockSobject).toHaveBeenCalledWith("ApexLog");
      expect(mockFindOne).toHaveBeenCalledWith(
        { LogUserId: testUserId },
        ["Id", "DurationMilliseconds"],
        { sort: { StartTime: -1 } },
      );
      expect(mockRequest).toHaveBeenCalledWith(
        `/sobjects/ApexLog/${testLogId}/Body/`,
      );

      const decoded = toonDecode(result);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
      expect(decoded.fileSizeBytes).toBe(1024);
      expect(decoded.org).toBe("test@example.com");
      expect(decoded.succeeded).toBe(true);
      expect(decoded.exceptionMessage).toBeUndefined();
      expect(decoded.durationMs).toBe(150);
    });

    it("should throw error when connection username cannot be determined", async () => {
      mockGetUsername.mockReturnValue(null);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Could not determine username from connection");

      expect(getUserIdByUsername).not.toHaveBeenCalled();
      expect(getOrCreateDebugLevelId).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should throw error when Apex compilation fails", async () => {
      const args: ExecuteAnonymousArgs = { apex: "Invalid Apex;" };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: false,
        success: false,
        line: 1,
        column: 5,
        compileProblem: "Unexpected token 'Invalid'",
      });

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow(
        "Apex could not be compiled at line 1, column 5: Unexpected token 'Invalid'",
      );

      expect(mockSobject).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should throw error when apexResult is null", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockExecuteAnonymous.mockResolvedValue(null);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Cannot read properties of null");

      expect(mockSobject).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should throw error when no log is found", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue(null);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Could not retrieve log from anonymous execution");

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should query for most recent log by StartTime", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockFindOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Array),
        { sort: { StartTime: -1 } },
      );
    });

    it("should handle multi-line Apex code", async () => {
      const multiLineApex = `
        Integer x = 10;
        Integer y = 20;
        System.debug('Sum: ' + (x + y));
      `;
      const args: ExecuteAnonymousArgs = { apex: multiLineApex };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(multiLineApex);
      const decoded = toonDecode(result);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
    });

    it("should propagate errors from getUserIdByUsername", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const userError = new Error("User not found");

      const mockGetUserIdByUsername =
        getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>;
      mockGetUserIdByUsername.mockRejectedValue(userError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("User not found");

      expect(getOrCreateDebugLevelId).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should propagate errors from getOrCreateDebugLevelId", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const debugLevelError = new Error("Failed to create debug level");

      const mockGetOrCreateDebugLevelId =
        getOrCreateDebugLevelId as jest.MockedFunction<
          typeof getOrCreateDebugLevelId
        >;
      mockGetOrCreateDebugLevelId.mockRejectedValue(debugLevelError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Failed to create debug level");

      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should propagate errors from ensureTraceFlag", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const traceFlagError = new Error("Failed to create trace flag");

      const mockEnsureTraceFlag = ensureTraceFlag as jest.MockedFunction<
        typeof ensureTraceFlag
      >;
      mockEnsureTraceFlag.mockRejectedValue(traceFlagError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Failed to create trace flag");

      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should handle errors from tooling.executeAnonymous", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const executeError = new Error("Tooling API error");

      mockExecuteAnonymous.mockRejectedValue(executeError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Tooling API error");

      expect(mockSobject).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should handle errors from findOne query", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const queryError = new Error("Query failed");

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockRejectedValue(queryError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Query failed");

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should handle errors from request", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const requestError = new Error("Failed to fetch log body");

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockRejectedValue(requestError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Failed to fetch log body");
    });

    it("should use getUserIdByUsername for log query", async () => {
      const customUserId = "005CUSTOMUSERID";
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      // Mock getUserIdByUsername to return custom user ID
      (
        getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>
      ).mockResolvedValue(customUserId);

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockFindOne).toHaveBeenCalledWith(
        { LogUserId: customUserId },
        ["Id", "DurationMilliseconds"],
        expect.any(Object),
      );
    });

    it("should handle SOQL queries in Apex", async () => {
      const soqlApex =
        "List<Account> accounts = [SELECT Id FROM Account LIMIT 10];";
      const args: ExecuteAnonymousArgs = { apex: soqlApex };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(soqlApex);
      const decoded = toonDecode(result);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
    });

    it("should handle DML operations in Apex", async () => {
      const dmlApex = "Account acc = new Account(Name='Test'); insert acc;";
      const args: ExecuteAnonymousArgs = { apex: dmlApex };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(dmlApex);
      const decoded = toonDecode(result);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
    });

    it("should throw error when connect() fails (no default org)", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const connectError = new Error(
        "No default org configured. Please set a default org using 'sf config set target-org <username>'.",
      );

      mockResolveOrg.mockRejectedValue(connectError);

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("No default org configured");

      expect(getUserIdByUsername).not.toHaveBeenCalled();
      expect(getOrCreateDebugLevelId).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });
  });

  describe("execution policy", () => {
    let consoleError: jest.SpyInstance;

    /** The confirmation the first round asks for. */
    function confirmRequest(result: InputRequiredResult): ElicitRequest["params"] {
      const request = result.inputRequests?.["confirm"] as
        | ElicitRequest
        | undefined;
      if (!request) {
        throw new Error("expected a 'confirm' input request");
      }
      return request.params;
    }

    function assertInputRequired(result: unknown): InputRequiredResult {
      const required = result as InputRequiredResult;
      expect(required.resultType).toBe("input_required");
      return required;
    }

    /** The call the client re-sends once the user has answered. */
    async function retryCtx(
      result: InputRequiredResult,
      response: unknown,
    ): Promise<ServerContext> {
      const state = await codec.verify(
        result.requestState as string,
        makeCtx(),
      );
      return makeCtx(state, { confirm: response });
    }

    afterEach(() => {
      consoleError.mockRestore();
    });

    beforeEach(() => {
      // Several of these paths log the underlying failure by design.
      consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });
      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);
    });

    it("should run against a sandbox without prompting", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(toonDecode(result).orgType).toBe("sandbox");
      expect(mockExecuteAnonymous).toHaveBeenCalledWith(testApexCode);
    });

    it("should ask for confirmation on the first production call", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = assertInputRequired(
        await executeAnonymous(mockServer, args, ctx, policy()),
      );

      const params = confirmRequest(result);
      expect(params.message).toContain("PRODUCTION org 'test@example.com'");
      expect(params.message).toContain(testApexCode);
      expect(typeof result.requestState).toBe("string");
    });

    it("should refuse a production call whose client carried no answer", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const asked = assertInputRequired(
        await executeAnonymous(mockServer, args, ctx, policy()),
      );
      const state = await codec.verify(
        asked.requestState as string,
        makeCtx(),
      );

      const result: any = await executeAnonymous(
        mockServer,
        args,
        makeCtx(state, {}),
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Cannot execute anonymous Apex against production org",
      );
      expect(result.content[0].text).toContain("--allow-production-orgs");
    });

    it("should not touch the org when a production call is refused", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(getOrCreateDebugLevelId).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should run against production when --allow-production-orgs is set", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ allowProductionOrgs: true }),
      );

      expect(toonDecode(result).orgType).toBe("production");
      expect(mockExecuteAnonymous).toHaveBeenCalledWith(testApexCode);
    });

    it("should run against production when the retry confirms", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const asked = assertInputRequired(
        await executeAnonymous(mockServer, args, ctx, policy()),
      );

      const result = await executeAnonymous(
        mockServer,
        args,
        await retryCtx(asked, {
          action: "accept",
          content: { confirm: true },
        }),
        policy(),
      );

      expect(toonDecode(result).orgType).toBe("production");
      expect(mockExecuteAnonymous).toHaveBeenCalledWith(testApexCode);
    });

    it.each([
      ["decline", { action: "decline" }],
      ["cancel", { action: "cancel" }],
      [
        "accept with confirm false",
        { action: "accept", content: { confirm: false } },
      ],
    ])("should refuse when the retry answers %s", async (_name, response) => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const asked = assertInputRequired(
        await executeAnonymous(mockServer, args, ctx, policy()),
      );

      const result: any = await executeAnonymous(
        mockServer,
        args,
        await retryCtx(asked, response),
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("User declined");
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should refuse a retry that asks for different Apex", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const asked = assertInputRequired(
        await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        ),
      );

      const result: any = await executeAnonymous(
        mockServer,
        { apex: "delete [SELECT Id FROM Account];" },
        await retryCtx(asked, {
          action: "accept",
          content: { confirm: true },
        }),
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not match this call");
      expect(getOrCreateDebugLevelId).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should treat an unverifiable org as production and surface the reason", async () => {
      mockRetrieveOrgInfo.mockRejectedValue(
        new Error("Unable to refresh session due to: inactive organization"),
      );
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const asked = assertInputRequired(
        await executeAnonymous(mockServer, args, ctx, policy()),
      );
      const state = await codec.verify(
        asked.requestState as string,
        makeCtx(),
      );

      const result: any = await executeAnonymous(
        mockServer,
        args,
        makeCtx(state, {}),
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("could not be verified");
      // The reason has to reach the agent so it can suggest re-authenticating.
      expect(result.content[0].text).toContain(
        "Reason: Unable to refresh session due to: inactive organization",
      );
      expect(result.content[0].text).toContain("re-authenticate");
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should classify the org once per cache", async () => {
      const cache = new Map();
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ctx, policy({ classificationCache: cache }));
      await executeAnonymous(mockServer, args, ctx, policy({ classificationCache: cache }));

      expect(mockRetrieveOrgInfo).toHaveBeenCalledTimes(1);
    });

    it("should refuse immediately when apex execution is disabled", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result: any = await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ apexExecutionDisabled: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "disabled by server configuration (--no-apex-execution)",
      );
      expect(mockResolveOrg).not.toHaveBeenCalled();
      expect(mockServer.server.listRoots).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });
  });

  describe("org username in response", () => {
    beforeEach(() => {
      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });
      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);
    });

    it("should include org username in response when no alias", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(toonDecode(result).org).toBe("test@example.com");
    });

    it("should include org username and alias in response when alias exists", async () => {
      mockStateAggregatorGetInstance.mockResolvedValue({
        aliases: {
          resolveUsername: jest.fn((input: string) => input),
          get: jest.fn(() => "myalias"),
        },
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(toonDecode(result).org).toBe("test@example.com (myalias)");
    });
  });

  describe("log file saving", () => {
    beforeEach(() => {
      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });
      mockFindOne.mockResolvedValue({
        Id: testLogId,
        DurationMilliseconds: 150,
      });
      mockRequest.mockResolvedValue(testLogBody);
    });

    it("should create output directory with recursive option", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining(".apex-log-mcp"),
        { recursive: true },
      );
    });

    it("should write log file with logId as filename", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(`${testLogId}.log`),
        testLogBody,
        "utf-8",
      );
    });

    it("should use custom outputDir when provided", async () => {
      const args: ExecuteAnonymousArgs = {
        apex: testApexCode,
        outputDir: "/custom/output",
      };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockMkdir).toHaveBeenCalledWith("/custom/output", {
        recursive: true,
      });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/custom\/output\/.+\.log$/),
        testLogBody,
        "utf-8",
      );
    });

    it("anchors a relative outputDir to the project root, so the returned path is absolute", async () => {
      (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
        roots: [{ uri: "file:///my/project" }],
      });

      const args: ExecuteAnonymousArgs = {
        apex: testApexCode,
        outputDir: "logs",
      };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockMkdir).toHaveBeenCalledWith("/my/project/logs", {
        recursive: true,
      });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/my\/project\/logs\/.+\.log$/),
        testLogBody,
        "utf-8",
      );
    });

    describe("outputDir outside the client roots", () => {
      const textOf = (result: Awaited<ReturnType<typeof executeAnonymous>>) =>
        result.content[0]?.text ?? "";

      let consoleError: jest.SpyInstance;

      beforeEach(() => {
        consoleError = jest.spyOn(console, "error").mockImplementation();
      });

      afterEach(() => consoleError.mockRestore());

      const withRoot = async (outputDir?: string) => {
        (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
          roots: [{ uri: "file:///my/project" }],
        });
        return executeAnonymous(
          mockServer,
          { apex: testApexCode, ...(outputDir && { outputDir }) },
          ctx,
          policy(),
        );
      };

      it("warns in the response and on stderr, and still writes the log", async () => {
        const result = await withRoot("/elsewhere/logs");

        expect(textOf(result)).toContain(
          "Debug log written to /elsewhere/logs, which is outside every root this client declared.",
        );
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("/elsewhere/logs"),
        );
        expect(mockWriteFile).toHaveBeenCalled();
      });

      it.each([
        ["inside a root", "/my/project/logs"],
        ["the root itself", "/my/project"],
      ])("stays silent for %s", async (_name, outputDir) => {
        expect(textOf(await withRoot(outputDir))).not.toContain("warning");
      });

      it("stays silent for the default outputDir", async () => {
        expect(textOf(await withRoot())).not.toContain("warning");
      });

      it("stays silent when the client declares no roots", async () => {
        (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
          roots: [],
        });

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, outputDir: "/elsewhere/logs" },
          ctx,
          policy(),
        );

        expect(textOf(result)).not.toContain("warning");
      });

      it("follows symlinks, so a link inside a root that leaves one warns", async () => {
        // The first call resolves outputDir; the roots after it keep the
        // resolves-to-itself default.
        (fs.realpath as unknown as jest.Mock).mockImplementationOnce(() =>
          Promise.resolve("/elsewhere/logs"),
        );

        expect(textOf(await withRoot("/my/project/logs"))).toContain(
          "/elsewhere/logs",
        );
      });
    });

    it("should default outputDir to .apex-log-mcp in project root", async () => {
      (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
        roots: [{ uri: "file:///my/project" }],
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockMkdir).toHaveBeenCalledWith("/my/project/.apex-log-mcp", {
        recursive: true,
      });
    });

    it("should return file size from stat", async () => {
      mockStat.mockResolvedValue({ size: 2048 } as any);

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(toonDecode(result).fileSizeBytes).toBe(2048);
    });

    it("should include succeeded false and exceptionMessage on runtime failure", async () => {
      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: false,
        line: -1,
        column: -1,
        exceptionMessage:
          "System.NullPointerException: Attempt to de-reference a null object",
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      const decoded = toonDecode(result);
      expect(decoded.succeeded).toBe(false);
      expect(decoded.exceptionMessage).toBe(
        "System.NullPointerException: Attempt to de-reference a null object",
      );
      expect(decoded.filePath).toContain(`${testLogId}.log`);
    });

    it("should say the output dir is new when it created it", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      // mkdir resolves to the first directory it created, so a value here means the
      // caller has a brand new directory that nothing yet ignores.
      mockMkdir.mockResolvedValueOnce("/project/.apex-log-mcp");

      expect(
        toonDecode(await executeAnonymous(mockServer, args, ctx, policy()))
          .outputDirCreated,
      ).toBe(true);
    });

    it("should say the output dir is not new when it already existed", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockMkdir.mockResolvedValueOnce(undefined);

      expect(
        toonDecode(await executeAnonymous(mockServer, args, ctx, policy()))
          .outputDirCreated,
      ).toBe(false);
    });
  });

  describe("executeAnonymousToolConfig", () => {
    it("should have correct tool definition", async () => {
      const { executeAnonymousToolConfig, executeAnonymousInputSchema } =
        await import("../src/tools/executeAnonymous");

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

    it("should accept the three debugLevel forms and reject an unknown category", async () => {
      const { executeAnonymousInputSchema } = await import(
        "../src/tools/executeAnonymous"
      );
      const debugLevel = executeAnonymousInputSchema.debugLevel;

      expect(debugLevel.safeParse("default").success).toBe(true);
      expect(debugLevel.safeParse("FINEST").success).toBe(true);
      expect(
        debugLevel.safeParse({ apexCode: "FINEST", database: "NONE" }).success,
      ).toBe(true);

      expect(debugLevel.safeParse("LOUDEST").success).toBe(false);
      expect(debugLevel.safeParse({ apexCode: "LOUDEST" }).success).toBe(false);
      expect(debugLevel.safeParse({ notACategory: "FINE" }).success).toBe(
        false,
      );
    });

    it("should flag the tool as disabled in its description when execution is off", async () => {
      const { executeAnonymousToolConfig } = await import(
        "../src/tools/executeAnonymous"
      );

      const config = executeAnonymousToolConfig(true);

      expect(config.description).toContain("[DISABLED on this server]");
      expect(config.description).toContain("--no-apex-execution");
    });
  });

  function toonDecode(result: any): any {
    return decode(result.content[0].text) as any;
  }
});
