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
  ensureDebugLevel: jest.fn(),
}));

jest.mock("../src/salesforce/traceFlags", () => ({
  ensureTraceFlag: jest.fn(),
}));

jest.mock("../src/salesforce/connection", () => ({
  resolveOrg: jest.fn(),
}));

// The written file is never on disk here, so the parse cannot be the real one.
jest.mock("../src/tools/apexLogSource", () => ({
  loadApexLog: jest.fn(),
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
import {
  ensureDebugLevel,
  DEFAULT_TRACE_CONFIG,
} from "../src/salesforce/debugLevels";
import { ensureTraceFlag } from "../src/salesforce/traceFlags";
import { resolveOrg } from "../src/salesforce/connection";
import { loadApexLog } from "../src/tools/apexLogSource";
import type { ApexLog } from "../src/ApexLogParser";
import type { OrgClassification } from "../src/salesforce/orgClassification";
import type { ConfirmationState } from "../src/policy/orgExecutionPolicy";

const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockStat = fs.stat as jest.MockedFunction<typeof fs.stat>;

const mockResolveOrg = resolveOrg as jest.MockedFunction<typeof resolveOrg>;
const mockEnsureDebugLevel = ensureDebugLevel as jest.MockedFunction<
  typeof ensureDebugLevel
>;
const mockLoadApexLog = loadApexLog as jest.MockedFunction<typeof loadApexLog>;
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

const TEST_ORG_ID = "00D000000000001";
const TEST_SESSION_ID = `${TEST_ORG_ID}!sessionpart`;
const TEST_INSTANCE_URL = "https://example.my.salesforce.com";
const TEST_API_VERSION = "67.0";

/** A log header carrying exactly the levels the DebugLevel record holds. */
const DEFAULT_LOG_HEADER = `${TEST_API_VERSION} APEX_CODE,FINE;APEX_PROFILING,FINE;CALLOUT,DEBUG;DATA_ACCESS,FINEST;DB,FINEST;NBA,INFO;SYSTEM,DEBUG;VALIDATION,DEBUG;VISUALFORCE,FINE;WAVE,INFO;WORKFLOW,FINE`;

/** The same log with APEX_CODE lowered, as a Developer Console flag would. */
const OVERRIDDEN_LOG_HEADER = DEFAULT_LOG_HEADER.replace(
  "APEX_CODE,FINE",
  "APEX_CODE,ERROR",
);

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

/** The Apex as the envelope has to carry it. */
function xmlEscaped(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char);
}

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
function makeCtx(
  state?: ConfirmationState,
  inputResponses?: unknown,
  extra: { _meta?: unknown; notify?: jest.Mock } = {},
) {
  return {
    mcpReq: {
      requestState: () => state,
      inputResponses,
      ...extra,
    },
  } as unknown as ServerContext;
}

describe("Execute Anonymous", () => {
  const testUserId = "005000000000001";
  const testDebugLevelId = "07L000000000001";
  const testLogId = "07L000000000002";
  const testLogBody = `${DEFAULT_LOG_HEADER}\nAPEX DEBUG LOG CONTENT HERE\n`;
  const testApexCode = "System.debug('Hello World');";

  let mockServer: McpServer;
  let mockConnection: any;
  let mockRequest: any;
  let mockGetUsername: any;
  let mockSobject: any;
  let mockFindOne: any;
  let mockOrg: any;
  let mockRetrieveOrgInfo: jest.Mock;
  let ctx: ServerContext;

  /** The parsed SOAP envelope `conn.request` hands back. */
  function soapResponse(
    result: Record<string, string> = {},
    debugLog: string = testLogBody,
  ) {
    return {
      "soapenv:Envelope": {
        "soapenv:Header": { DebuggingInfo: { debugLog } },
        "soapenv:Body": {
          executeAnonymousResponse: {
            result: {
              compiled: "true",
              success: "true",
              line: "-1",
              column: "-1",
              ...result,
            },
          },
        },
      },
    };
  }

  /** The envelope body of the one POST this call made. */
  function postedEnvelope(): string {
    expect(mockRequest).toHaveBeenCalledTimes(1);
    return mockRequest.mock.calls[0][0].body as string;
  }

  function expectPostedApex(apex: string): void {
    expect(postedEnvelope()).toContain(
      `<apexcode>${xmlEscaped(apex)}</apexcode>`,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();

    ctx = makeCtx();

    mockServer = {
      server: {
        listRoots: jest.fn().mockResolvedValue({ roots: [] }),
      },
    } as unknown as McpServer;

    mockRequest = jest.fn().mockResolvedValue(soapResponse());
    mockGetUsername = jest.fn().mockReturnValue("test@example.com");

    mockFindOne = jest.fn().mockResolvedValue({ Id: testLogId });
    mockSobject = jest.fn().mockReturnValue({ findOne: mockFindOne });

    mockConnection = {
      sobject: mockSobject,
      request: mockRequest,
      getUsername: mockGetUsername,
      accessToken: TEST_SESSION_ID,
      instanceUrl: TEST_INSTANCE_URL,
      version: TEST_API_VERSION,
      userInfo: {
        id: testUserId,
      },
    };

    mockRetrieveOrgInfo = jest.fn().mockResolvedValue(SANDBOX_ORG_INFO);
    mockOrg = {
      getConnection: jest.fn(() => mockConnection),
      getOrgId: jest.fn(() => TEST_ORG_ID),
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
    mockEnsureDebugLevel.mockResolvedValue({
      id: testDebugLevelId,
      levels: DEFAULT_TRACE_CONFIG,
    });
    (
      ensureTraceFlag as jest.MockedFunction<typeof ensureTraceFlag>
    ).mockResolvedValue();
    mockLoadApexLog.mockResolvedValue({
      duration: { total: 150_000_000 },
    } as ApexLog);
  });

  describe("executeAnonymous", () => {
    it("should successfully execute Apex and return log", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(getUserIdByUsername).toHaveBeenCalledWith(
        mockConnection,
        "test@example.com",
      );
      expect(ensureDebugLevel).toHaveBeenCalledWith(mockConnection, undefined);
      expect(ensureTraceFlag).toHaveBeenCalledWith(
        mockConnection,
        testUserId,
        testDebugLevelId,
      );
      expectPostedApex(testApexCode);
      expect(mockSobject).toHaveBeenCalledWith("ApexLog");

      const decoded = toonDecode(result);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
      expect(decoded.fileSizeBytes).toBe(1024);
      expect(decoded.org).toBe("test@example.com");
      expect(decoded.succeeded).toBe(true);
      expect(decoded.exceptionMessage).toBeUndefined();
      expect(decoded.levelsOverridden).toBe(false);
    });

    // The log is the one source of its own duration, so this figure and
    // apexlog_get_summary.durationTotalMs are the same number.
    it("reports the duration the written log parses to", async () => {
      mockLoadApexLog.mockResolvedValue({
        duration: { total: 2_500_000 },
      } as ApexLog);

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(mockLoadApexLog).toHaveBeenCalledWith(
        expect.stringContaining(`${testLogId}.log`),
      );
      expect(toonDecode(result).durationMs).toBe(2.5);
    });

    it("posts the SOAP envelope to the org id path segment", async () => {
      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: `${TEST_INSTANCE_URL}/services/Soap/s/${TEST_API_VERSION}/${TEST_ORG_ID}`,
          headers: {
            "content-type": "text/xml",
            soapaction: "executeAnonymous",
          },
        }),
      );
    });

    it("asks for every category at the level the DebugLevel record carries", async () => {
      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      const envelope = postedEnvelope();
      expect(envelope).toContain(
        `<apex:sessionId>${TEST_SESSION_ID}</apex:sessionId>`,
      );
      // SOAP spells both halves in title case — DB is Db, FINEST is Finest.
      expect(envelope).toContain(
        "<apex:category>Apex_code</apex:category><apex:level>Fine</apex:level>",
      );
      expect(envelope).toContain(
        "<apex:category>Db</apex:category><apex:level>Finest</apex:level>",
      );
      expect(envelope).not.toContain("Data_access");
    });

    it("reports levelsOverridden when the log came back at other levels", async () => {
      mockRequest.mockResolvedValue(
        soapResponse({}, `${OVERRIDDEN_LOG_HEADER}\nCONTENT\n`),
      );

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(toonDecode(result).levelsOverridden).toBe(true);
    });

    it("should throw error when connection username cannot be determined", async () => {
      mockGetUsername.mockReturnValue(null);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Could not determine username from connection");

      expect(getUserIdByUsername).not.toHaveBeenCalled();
      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should throw error when Apex compilation fails", async () => {
      const args: ExecuteAnonymousArgs = { apex: "Invalid Apex;" };

      mockRequest.mockResolvedValue(
        soapResponse({
          compiled: "false",
          success: "false",
          line: "1",
          column: "5",
          compileProblem: "Unexpected token 'Invalid'",
        }),
      );

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow(
        "Apex could not be compiled at line 1, column 5: Unexpected token 'Invalid'",
      );

      expect(mockSobject).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should throw error when the response carries no result", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockRequest.mockResolvedValue({});

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Apex could not be compiled");

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("names the file with a timestamp when no stored log matches", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(toonDecode(result).filePath).toMatch(/apex-\d+\.log$/);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    // The log is already in hand and cannot be fetched again, so a failure to
    // name it must not lose it.
    it("falls back to a timestamp when the log query fails", async () => {
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockFindOne.mockRejectedValue(new Error("Query failed"));

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(toonDecode(result).filePath).toMatch(/apex-\d+\.log$/);
      expect(mockWriteFile).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("matches the stored log on its byte length", async () => {
      const customUserId = "005CUSTOMUSERID";
      (
        getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>
      ).mockResolvedValue(customUserId);

      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(mockFindOne).toHaveBeenCalledWith(
        {
          LogUserId: customUserId,
          LogLength: Buffer.byteLength(testLogBody, "utf-8"),
        },
        ["Id"],
        { sort: { StartTime: -1 } },
      );
    });

    it("should handle multi-line Apex code", async () => {
      const multiLineApex = `
        Integer x = 10;
        Integer y = 20;
        System.debug('Sum: ' + (x + y));
      `;

      const result = await executeAnonymous(
        mockServer,
        { apex: multiLineApex },
        ctx,
        policy(),
      );

      expectPostedApex(multiLineApex);
      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should propagate errors from getUserIdByUsername", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const mockGetUserIdByUsername =
        getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>;
      mockGetUserIdByUsername.mockRejectedValue(new Error("User not found"));

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("User not found");

      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should propagate errors from ensureDebugLevel", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockEnsureDebugLevel.mockRejectedValue(
        new Error("Failed to create debug level"),
      );

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Failed to create debug level");

      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should propagate errors from ensureTraceFlag", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const mockEnsureTraceFlag = ensureTraceFlag as jest.MockedFunction<
        typeof ensureTraceFlag
      >;
      mockEnsureTraceFlag.mockRejectedValue(
        new Error("Failed to create trace flag"),
      );

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Failed to create trace flag");

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should handle errors from the SOAP call", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockRequest.mockRejectedValue(new Error("Apex SOAP API error"));

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("Apex SOAP API error");

      expect(mockSobject).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should throw when the connection carries no access token", async () => {
      mockConnection.accessToken = undefined;
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("The org connection carries no access token.");

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should handle SOQL queries in Apex", async () => {
      const soqlApex =
        "List<Account> accounts = [SELECT Id FROM Account LIMIT 10];";

      const result = await executeAnonymous(
        mockServer,
        { apex: soqlApex },
        ctx,
        policy(),
      );

      expectPostedApex(soqlApex);
      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should handle DML operations in Apex", async () => {
      const dmlApex = "Account acc = new Account(Name='Test'); insert acc;";

      const result = await executeAnonymous(
        mockServer,
        { apex: dmlApex },
        ctx,
        policy(),
      );

      expectPostedApex(dmlApex);
      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should throw error when connect() fails (no default org)", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockResolveOrg.mockRejectedValue(
        new Error(
          "No default org configured. Please set a default org using 'sf config set target-org <username>'.",
        ),
      );

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("No default org configured");

      expect(getUserIdByUsername).not.toHaveBeenCalled();
      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe("progress notifications", () => {
    it("reports every step to a caller that sent a progress token", async () => {
      const notify = jest.fn().mockResolvedValue(undefined);

      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        makeCtx(undefined, undefined, {
          _meta: { progressToken: 7 },
          notify,
        }),
        policy(),
      );

      expect(notify).toHaveBeenCalledTimes(4);
      expect(notify).toHaveBeenNthCalledWith(1, {
        method: "notifications/progress",
        params: {
          progressToken: 7,
          progress: 1,
          total: 4,
          message: "Connecting to the org",
        },
      });
      expect(notify.mock.calls[3][0].params).toEqual({
        progressToken: 7,
        progress: 4,
        total: 4,
        message: "Writing the debug log",
      });
    });

    // The spec gives a token only when the client wants the notifications.
    it("sends nothing when the call carried no token", async () => {
      const notify = jest.fn().mockResolvedValue(undefined);

      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        makeCtx(undefined, undefined, { notify }),
        policy(),
      );

      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("execution policy", () => {
    let consoleError: jest.SpyInstance;

    /** The confirmation the first round asks for. */
    function confirmRequest(
      result: InputRequiredResult,
    ): ElicitRequest["params"] {
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
    });

    it("should run against a sandbox without prompting", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ctx, policy());

      expect(toonDecode(result).orgType).toBe("sandbox");
      expectPostedApex(testApexCode);
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

      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
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
      expectPostedApex(testApexCode);
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
      expectPostedApex(testApexCode);
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
      expect(mockRequest).not.toHaveBeenCalled();
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
      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
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
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should classify the org once per cache", async () => {
      const cache = new Map();
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ classificationCache: cache }),
      );
      await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ classificationCache: cache }),
      );

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
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe("org username in response", () => {
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
    it("should create output directory with recursive option", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ctx, policy());

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining(".apex-log-mcp"),
        { recursive: true },
      );
    });

    it("should write the returned log with logId as filename", async () => {
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
      mockRequest.mockResolvedValue(
        soapResponse({
          success: "false",
          exceptionMessage:
            "System.NullPointerException: Attempt to de-reference a null object",
        }),
      );

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

      expect(config.description).toContain(
        "Execute a snippet of anonymous Apex",
      );
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
