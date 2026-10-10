/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("node:fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    link: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue({ size: 1024 }),
    open: jest.fn(),
    // No symlinks in the test filesystem, so every path resolves to itself.
    realpath: jest.fn((target: string) => Promise.resolve(target)),
  },
  constants: { O_RDONLY: 0, O_NONBLOCK: 4 },
}));

jest.mock("../src/salesforce/users", () => ({
  getUserIdByUsername: jest.fn(),
}));

// Only the network call is mocked, so DEFAULT_TRACE_CONFIG is the real one:
// the tests below assert the levels this tool asks the org for.
jest.mock("../src/salesforce/debugLevels", () => ({
  ...jest.requireActual("../src/salesforce/debugLevels"),
  ensureDebugLevel: jest.fn(),
}));

jest.mock("../src/salesforce/traceFlags", () => ({
  findActiveTraceFlags: jest.fn(),
  createTraceFlag: jest.fn(),
  deleteTraceFlag: jest.fn(),
}));

jest.mock("../src/salesforce/connection", () => ({
  readLocalOrg: jest.fn(),
  connectOrg: jest.fn(),
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
  };
});

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  McpServer,
  SdkError,
  SdkErrorCode,
  type ElicitRequest,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { ConfigAggregator, type AuthInfo } from "@salesforce/core";
import { decode } from "@toon-format/toon";
import {
  executeAnonymous,
  MAX_APEX_TO_CONFIRM,
} from "../src/tools/executeAnonymous";
import {
  executeAnonymousInputSchema,
  type ExecuteAnonymousArgs,
} from "../src/tools/executeAnonymousDefinition";
import { getUserIdByUsername } from "../src/salesforce/users";
import {
  ensureDebugLevel,
  DEFAULT_TRACE_CONFIG,
  levelsClause,
  requestedLevels,
} from "../src/salesforce/debugLevels";
import {
  createTraceFlag,
  deleteTraceFlag,
  findActiveTraceFlags,
} from "../src/salesforce/traceFlags";
import {
  connectOrg,
  readLocalOrg,
  type LocalOrg,
} from "../src/salesforce/connection";
import { loadApexLog } from "../src/tools/apexLogSource";
import type { ApexLog } from "@apexdevtools/apex-log-parser";
import type { OrgClassification } from "../src/salesforce/orgClassification";
import { compileDenyList, type DenyList } from "../src/policy/orgDenyList";
import {
  createConfirmationLedger,
  type ConfirmationState,
} from "../src/policy/orgExecutionPolicy";

const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockLink = fs.link as jest.MockedFunction<typeof fs.link>;
const mockStat = fs.stat as jest.MockedFunction<typeof fs.stat>;

const mockConnectOrg = connectOrg as jest.MockedFunction<typeof connectOrg>;
const mockEnsureDebugLevel = ensureDebugLevel as jest.MockedFunction<
  typeof ensureDebugLevel
>;
const mockLoadApexLog = loadApexLog as jest.MockedFunction<typeof loadApexLog>;
const mockFindActiveTraceFlags = findActiveTraceFlags as jest.MockedFunction<
  typeof findActiveTraceFlags
>;

/** A user's own trace flag levels, unlike the defaults in every category. */
const FLAG_LEVELS = {
  ...requestedLevels("NONE"),
  apexCode: "ERROR",
  database: "INFO",
  system: "WARN",
} as const;
const mockCreateTraceFlag = createTraceFlag as jest.MockedFunction<
  typeof createTraceFlag
>;
const mockDeleteTraceFlag = deleteTraceFlag as jest.MockedFunction<
  typeof deleteTraceFlag
>;
const mockConfigAggregatorCreate = ConfigAggregator.create as jest.Mock;
const mockReadLocalOrg = readLocalOrg as jest.MockedFunction<
  typeof readLocalOrg
>;

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

const LOCAL_ORG: LocalOrg = {
  orgId: TEST_ORG_ID,
  username: "test@example.com",
  aliases: [],
  instanceUrl: TEST_INSTANCE_URL,
  authInfo: {} as AuthInfo,
};

/** A log header carrying exactly the levels the DebugLevel record holds. */
/** The slack `findStoredLogId` allows between this clock and the org's. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const DEFAULT_LOG_HEADER = `${TEST_API_VERSION} APEX_CODE,FINE;APEX_PROFILING,FINE;CALLOUT,DEBUG;DATA_ACCESS,FINEST;DB,FINEST;NBA,INFO;SYSTEM,DEBUG;VALIDATION,DEBUG;VISUALFORCE,FINE;WAVE,INFO;WORKFLOW,FINE`;

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
    denyList?: DenyList;
    classificationCache?: Map<string, OrgClassification>;
  } = {},
) {
  return {
    allowProductionOrgs: false,
    apexExecutionDisabled: false,
    denyList: compileDenyList([]),
    classificationCache: new Map<string, OrgClassification>(),
    mintConfirmationState: (payload: ConfirmationState) => codec.mint(payload),
    consumeConfirmation: createConfirmationLedger(),
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
      signal: new AbortController().signal,
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
  const testTraceFlagId = "7tf000000000001";
  const testLogBody = `${DEFAULT_LOG_HEADER}\nAPEX DEBUG LOG CONTENT HERE\n`;
  const testApexCode = "System.debug('Hello World');";

  let mockServer: McpServer;
  const rejectRoots = (code: SdkErrorCode, message: string) =>
    (mockServer.server.listRoots as jest.Mock).mockRejectedValue(
      new SdkError(code, message),
    );
  let mockConnection: any;
  let mockRequest: any;
  let mockSobject: any;
  let mockFind: any;
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
        // The SDK's answer, under enforceStrictCapabilities, for a client that declared no roots.
        listRoots: jest
          .fn()
          .mockRejectedValue(
            new SdkError(
              SdkErrorCode.CapabilityNotSupported,
              "Client does not support listing roots",
            ),
          ),
      },
    } as unknown as McpServer;

    mockRequest = jest.fn().mockResolvedValue(soapResponse());

    mockFind = jest.fn().mockResolvedValue([{ Id: testLogId }]);
    mockSobject = jest.fn().mockReturnValue({ find: mockFind });

    mockConnection = {
      sobject: mockSobject,
      request: mockRequest,
      getApiVersion: () => TEST_API_VERSION,
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

    mockConnectOrg.mockResolvedValue(mockOrg);

    mockReadLocalOrg.mockResolvedValue(LOCAL_ORG);

    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: jest.fn(() => undefined),
    });

    (
      getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>
    ).mockResolvedValue(testUserId);
    mockEnsureDebugLevel.mockResolvedValue(testDebugLevelId);
    mockFindActiveTraceFlags.mockResolvedValue({ storesLogs: false });
    mockCreateTraceFlag.mockResolvedValue(testTraceFlagId);
    mockDeleteTraceFlag.mockResolvedValue();
    mockLoadApexLog.mockResolvedValue({
      duration: { total: 150_000_000 },
      debugLevels: DEFAULT_TRACE_CONFIG,
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
      expect(ensureDebugLevel).toHaveBeenCalledWith(mockConnection);
      expect(createTraceFlag).toHaveBeenCalledWith(
        mockConnection,
        testUserId,
        testDebugLevelId,
        15 * 60 * 1000,
      );
      expect(deleteTraceFlag).toHaveBeenCalledWith(
        mockConnection,
        testTraceFlagId,
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

    it("asks for every category at the defaults when the user has no trace flag", async () => {
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
      // SOAP spells both halves in title case - DB is Db, FINEST is Finest.
      expect(envelope).toContain(
        "<apex:category>Apex_code</apex:category><apex:level>Fine</apex:level>",
      );
      expect(envelope).toContain(
        "<apex:category>Db</apex:category><apex:level>Finest</apex:level>",
      );
      expect(envelope).not.toContain("Data_access");
    });

    // APEX_CODE lowered, as a Developer Console flag would.
    it("reports levelsOverridden when the log came back at other levels", async () => {
      mockLoadApexLog.mockResolvedValue({
        duration: { total: 150_000_000 },
        debugLevels: { ...DEFAULT_TRACE_CONFIG, apexCode: "ERROR" },
      } as ApexLog);

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(toonDecode(result).levelsOverridden).toBe(true);
    });

    describe("log levels", () => {
      const withFlag = () =>
        mockFindActiveTraceFlags.mockResolvedValue({
          storesLogs: true,
          userDebugLevels: FLAG_LEVELS,
        });

      // With no header the returned log is empty, so the flag's levels are read and sent.
      it("should run at the user's trace flag levels when debugLevel is left out", async () => {
        withFlag();

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        );

        expect(postedEnvelope()).toContain(
          "<apex:category>Apex_code</apex:category><apex:level>Error</apex:level>",
        );
        expect(postedEnvelope()).toContain(
          "<apex:category>Db</apex:category><apex:level>Info</apex:level>",
        );
        expect(toonDecode(result).levelsSource).toBe("traceFlag");
      });

      it("should run at the defaults when debugLevel is left out and the user has no flag", async () => {
        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        );

        expect(toonDecode(result).levelsSource).toBe("default");
      });

      it('should run at the trace flag levels for "traceFlag"', async () => {
        withFlag();

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, debugLevel: "traceFlag" },
          ctx,
          policy(),
        );

        expect(toonDecode(result).levelsSource).toBe("traceFlag");
      });

      // Flags expire within a day, and a caller who named the flag must hear it is gone.
      it('should refuse "traceFlag" when the user has no flag, before the org is written to', async () => {
        await expect(
          executeAnonymous(
            mockServer,
            { apex: testApexCode, debugLevel: "traceFlag" },
            ctx,
            policy(),
          ),
        ).rejects.toThrow(
          "test@example.com has no active USER_DEBUG trace flag, so there are no levels to use. Create one, or leave out debugLevel to run at the defaults.",
        );
        expect(ensureDebugLevel).not.toHaveBeenCalled();
        expect(createTraceFlag).not.toHaveBeenCalled();
        expect(mockRequest).not.toHaveBeenCalled();
      });

      it('should refuse "traceFlag" when only a Developer Console flag is live', async () => {
        mockFindActiveTraceFlags.mockResolvedValue({ storesLogs: true });

        await expect(
          executeAnonymous(
            mockServer,
            { apex: testApexCode, debugLevel: "traceFlag" },
            ctx,
            policy(),
          ),
        ).rejects.toThrow("has no active USER_DEBUG trace flag");
      });

      // It outranks the header, so its levels are the run's whatever was asked for.
      it("should run at a live Developer Console flag's levels, and say so", async () => {
        mockFindActiveTraceFlags.mockResolvedValue({
          storesLogs: true,
          developerConsoleLevels: FLAG_LEVELS,
        });

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, debugLevel: "FINEST" },
          ctx,
          policy(),
        );

        expect(postedEnvelope()).toContain(
          "<apex:category>Apex_code</apex:category><apex:level>Error</apex:level>",
        );
        expect(toonDecode(result).levelsSource).toBe("developerConsole");
      });

      it('should run at the defaults for "default", even with a flag', async () => {
        withFlag();

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, debugLevel: "default" },
          ctx,
          policy(),
        );

        expect(postedEnvelope()).toContain(
          "<apex:category>Apex_code</apex:category><apex:level>Fine</apex:level>",
        );
        expect(toonDecode(result).levelsSource).toBe("default");
      });

      // Over the defaults, never over the flag or a previous run.
      it("should set the categories an object names over the defaults", async () => {
        withFlag();

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, debugLevel: { apexCode: "FINEST" } },
          ctx,
          policy(),
        );

        expect(postedEnvelope()).toContain(
          "<apex:category>Apex_code</apex:category><apex:level>Finest</apex:level>",
        );
        expect(postedEnvelope()).toContain(
          "<apex:category>Db</apex:category><apex:level>Finest</apex:level>",
        );
        expect(toonDecode(result).levelsSource).toBe("request");
      });
    });

    it("should connect to the org it checked, through the same auth", async () => {
      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(mockReadLocalOrg).toHaveBeenCalledWith(undefined, undefined);
      expect(mockConnectOrg).toHaveBeenCalledWith(LOCAL_ORG);
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
      mockFind.mockResolvedValue([]);

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
      mockFind.mockRejectedValue(new Error("Query failed"));

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

      expect(mockFind).toHaveBeenCalledWith(
        {
          LogUserId: customUserId,
          LogLength: Buffer.byteLength(testLogBody, "utf-8"),
          StartTime: { $gte: expect.anything() },
        },
        ["Id"],
        { sort: { StartTime: -1 }, limit: 5 },
      );
    });

    // A repeat run of the same Apex matches the earlier run's log too; only its body tells them apart.
    describe("when more than one stored log matches", () => {
      const earlierLogId = "07L000000000002AAA";

      function storedBodies(bodies: Record<string, string>) {
        const run = mockRequest.getMockImplementation();
        mockRequest.mockImplementation(async (request: unknown) => {
          const id = typeof request === "string" && /ApexLog\/(\w+)\/Body$/.exec(request)?.[1];
          return id ? bodies[id] : run!(request);
        });
      }

      it("names the file after the log whose body is this run's", async () => {
        mockFind.mockResolvedValue([{ Id: earlierLogId }, { Id: testLogId }]);
        storedBodies({
          // Same length, as a repeat run's log is, with its own content.
          [earlierLogId]: testLogBody.replace("HERE", "HER2"),
          [testLogId]: testLogBody,
        });

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        );

        expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
      });

      // `apexlog_get_org_logs` reuses a file saved under an id, so a guess must not be made.
      it("names the file with a timestamp when no body is this run's", async () => {
        mockFind.mockResolvedValue([{ Id: earlierLogId }, { Id: testLogId }]);
        storedBodies({ [earlierLogId]: "other", [testLogId]: "other" });

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        );

        expect(toonDecode(result).filePath).toMatch(/apex-\d+\.log$/);
      });
    });

    // Without the bound, a log of the same length from any earlier run answers
    // the query and names this run's file after it.
    it("matches only logs filed no earlier than this run", async () => {
      const before = Date.now();

      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      const { StartTime } = mockFind.mock.calls[0][0] as {
        StartTime: { $gte: { toString(): string } };
      };
      // The builder renders the bound with `String()`, and only a bare ISO 8601
      // literal is a date SOQL reads.
      const bound = String(StartTime.$gte);
      expect(bound).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(Date.parse(bound)).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);
      expect(Date.parse(bound)).toBeLessThanOrEqual(Date.now());
    });

    // The id is matched, not given, so a wrong match must cost a filename
    // rather than the log an earlier run left there.
    it("writes elsewhere rather than over a log already filed under the id", async () => {
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const exists = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      mockLink.mockRejectedValueOnce(exists);

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(mockLink).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${testLogId}\\.log\\.[\\w-]+\\.part$`)),
        expect.stringMatching(new RegExp(`${testLogId}\\.log$`)),
      );
      expect(toonDecode(result).filePath).toMatch(/apex-\d+\.log$/);
      consoleError.mockRestore();
    });

    // An empty file and a zero duration otherwise read as a run that did
    // nothing rather than a log that was never captured.
    it("says so when the org returned no debug log", async () => {
      mockRequest.mockResolvedValue(soapResponse({}, ""));

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      const payload = toonDecode(result);
      expect(payload.warning).toContain("no debug log");
      expect(payload.durationMs).toBe(0);
      expect(mockLoadApexLog).not.toHaveBeenCalled();
      // An empty log has no stored twin, so an earlier run's empty log must not name it.
      expect(mockFind).not.toHaveBeenCalled();
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
      expect(createTraceFlag).not.toHaveBeenCalled();
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

      expect(createTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    // A live flag already stores the log, and the header sets this run's levels.
    it("runs on the user's live trace flag and leaves it untouched", async () => {
      mockFindActiveTraceFlags.mockResolvedValue({ storesLogs: true });

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(findActiveTraceFlags).toHaveBeenCalledWith(
        mockConnection,
        testUserId,
      );
      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(createTraceFlag).not.toHaveBeenCalled();
      expect(deleteTraceFlag).not.toHaveBeenCalled();
      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    // Without a live flag Salesforce stores no log, so the flag lives until the id is matched.
    it("creates a flag for the run and deletes it once the log id is matched", async () => {
      const order: string[] = [];
      mockCreateTraceFlag.mockImplementation(async () => {
        order.push("create");
        return testTraceFlagId;
      });
      mockRequest.mockImplementation(async () => {
        order.push("run");
        return soapResponse();
      });
      mockFind.mockImplementation(async () => {
        order.push("match");
        return [{ Id: testLogId }];
      });
      mockDeleteTraceFlag.mockImplementation(async () => {
        order.push("delete");
      });

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(order).toEqual(["create", "run", "match", "delete"]);
      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
      expect(toonDecode(result).warning).toBeUndefined();
    });

    it("still deletes the flag it created when the Apex does not compile", async () => {
      mockRequest.mockResolvedValue(
        soapResponse({
          compiled: "false",
          line: "1",
          column: "5",
          compileProblem: "Unexpected token",
        }),
      );

      await expect(
        executeAnonymous(mockServer, { apex: testApexCode }, ctx, policy()),
      ).rejects.toThrow("Apex could not be compiled");

      expect(deleteTraceFlag).toHaveBeenCalledWith(
        mockConnection,
        testTraceFlagId,
      );
    });

    // The log is in hand and the flag expires on its own, so a failed delete only warns.
    it("returns the log and warns when the flag it created cannot be deleted", async () => {
      mockDeleteTraceFlag.mockRejectedValue(new Error("Locked"));

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      const decoded = toonDecode(result);
      expect(decoded.succeeded).toBe(true);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
      expect(decoded.warning).toContain(testTraceFlagId);
      expect(decoded.warning).toContain("15 minutes");
    });

    // The header returns the log without a flag; only the file's log id depends on one.
    it("runs and warns when Salesforce refuses the run's trace flag", async () => {
      mockCreateTraceFlag.mockRejectedValue(
        new Error("FIELD_INTEGRITY_EXCEPTION: overlapping trace flag"),
      );

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      const decoded = toonDecode(result);
      const runs = mockRequest.mock.calls.filter(
        ([request]: [unknown]) => typeof request !== "string",
      );
      expect(runs).toHaveLength(1);
      expect(deleteTraceFlag).not.toHaveBeenCalled();
      expect(decoded.succeeded).toBe(true);
      expect(decoded.warning).toContain("Could not set a trace flag");
      expect(decoded.warning).toContain("overlapping trace flag");
      // Another run's flag may have stored it, or nothing did, so the one match is checked.
      expect(mockRequest).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`ApexLog/${testLogId}/Body$`)),
      );
      // The stored body here is not this run's, so the file is named by time.
      expect(decoded.filePath).toMatch(/apex-\d+\.log$/);
    });

    // Two runs at once: the first run's flag refuses the second's, and stores its log.
    it("names the file by id when the run's flag is refused but its log was stored", async () => {
      mockCreateTraceFlag.mockRejectedValue(
        new Error("FIELD_INTEGRITY_EXCEPTION: already being traced"),
      );
      const run = mockRequest.getMockImplementation();
      mockRequest.mockImplementation(async (request: unknown) =>
        typeof request === "string" ? testLogBody : run!(request),
      );

      const result = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy(),
      );

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
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

      mockConnectOrg.mockRejectedValue(
        new Error(
          "No default org configured. Please set a default org using 'sf config set target-org <username>'.",
        ),
      );

      await expect(
        executeAnonymous(mockServer, args, ctx, policy()),
      ).rejects.toThrow("No default org configured");

      expect(getUserIdByUsername).not.toHaveBeenCalled();
      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(createTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe("apexFilePath", () => {
    const apexFilePath = "/project/scripts/apex/hello.apex";
    const mockOpen = fs.open as unknown as jest.Mock;
    const mockReadFile = jest.fn();
    const mockHandleStat = jest.fn();
    const mockClose = jest.fn();

    beforeEach(() => {
      mockReadFile.mockReset();
      mockHandleStat.mockReset().mockResolvedValue({ isFile: () => true });
      mockClose.mockReset().mockResolvedValue(undefined);
      mockOpen.mockResolvedValue({
        readFile: mockReadFile,
        stat: mockHandleStat,
        close: mockClose,
      });
    });

    const errno = (code: string) =>
      Object.assign(new Error(`${code}: failed`), { code });

    it("should refuse a relative path rather than resolve it against the server's cwd", () => {
      const result = executeAnonymousInputSchema.apexFilePath.safeParse(
        "scripts/apex/hello.apex",
      );

      expect(result.error?.issues[0]?.message).toBe("must be an absolute path");
    });

    it("should run the Apex the file holds", async () => {
      mockReadFile.mockResolvedValue(testApexCode);

      await executeAnonymous(mockServer, { apexFilePath }, ctx, policy());

      expect(mockOpen).toHaveBeenCalledWith(apexFilePath, expect.any(Number));
      expectPostedApex(testApexCode);
    });

    it.each([
      ["both", { apex: testApexCode, apexFilePath }],
      ["neither", {}],
    ])("should refuse a call that gives %s, before any work", async (_c, args) => {
      const result: any = await executeAnonymous(
        mockServer,
        args as ExecuteAnonymousArgs,
        ctx,
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("apex and apexFilePath");
      expect(mockReadLocalOrg).not.toHaveBeenCalled();
      expect(mockOpen).not.toHaveBeenCalled();
    });

    it.each([
      ["ENOENT", `Apex file not found: ${apexFilePath}`],
      ["EACCES", `Cannot read Apex file ${apexFilePath}: EACCES`],
    ])("should name why the file could not be read (%s), before connecting", async (code, message) => {
      mockOpen.mockRejectedValueOnce(errno(code));

      await expect(
        executeAnonymous(mockServer, { apexFilePath }, ctx, policy()),
      ).rejects.toThrow(message);
      expect(mockConnectOrg).not.toHaveBeenCalled();
    });

    it("should strip a byte order mark, which Salesforce fails to compile", async () => {
      mockReadFile.mockResolvedValue(`\uFEFF${testApexCode}`);

      await executeAnonymous(mockServer, { apexFilePath }, ctx, policy());

      expectPostedApex(testApexCode);
    });

    it("should refuse a device or a FIFO without reading it", async () => {
      mockHandleStat.mockResolvedValueOnce({ isFile: () => false });

      await expect(
        executeAnonymous(mockServer, { apexFilePath: "/dev/zero" }, ctx, policy()),
      ).rejects.toThrow("Cannot read Apex file /dev/zero: not a regular file");
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    describe("when the client's roots cannot be read", () => {
      beforeEach(() => {
        rejectRoots(
          SdkErrorCode.MethodNotSupportedByProtocolVersion,
          "roots/list cannot be sent on 2026-07-28",
        );
        // A 2026-07-28 client declares its capabilities on each request.
        ctx = {
          mcpReq: {
            ...ctx.mcpReq,
            envelope: { [CLIENT_CAPABILITIES_META_KEY]: { roots: {} } },
          },
        } as unknown as ServerContext;
      });

      it("should refuse a file before any local work on 2026-07-28, since nothing can show it is inside a root", async () => {
        const result: any = await executeAnonymous(
          mockServer,
          { apexFilePath },
          ctx,
          policy(),
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(
          `Cannot check Apex file ${apexFilePath}: this server cannot yet ask a 2026-07-28 client for its roots. Pass the Apex inline in apex.`,
        );
        expect(mockReadLocalOrg).not.toHaveBeenCalled();
        expect(mockOpen).not.toHaveBeenCalled();
      });

      it("should refuse a file when a client that declared roots does not answer", async () => {
        rejectRoots(SdkErrorCode.RequestTimeout, "Request timed out");

        const result: any = await executeAnonymous(
          mockServer,
          { apexFilePath },
          ctx,
          policy(),
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          "the client's roots could not be read: Request timed out.",
        );
        expect(mockOpen).not.toHaveBeenCalled();
      });

      it("should say an outputDir was not checked, rather than stay silent", async () => {
        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, outputDir: "/elsewhere/logs", targetOrg: "psa" },
          ctx,
          policy(),
        );

        expect(result.content[0]?.text).toContain(
          "Debug log written to /elsewhere/logs, which was not checked against the client's roots: this server cannot yet ask a 2026-07-28 client for its roots.",
        );
      });

      it("should say the default outputDir was not checked, since it falls back to the cwd", async () => {
        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, targetOrg: "psa" },
          ctx,
          policy(),
        );

        expect(result.content[0]?.text).toContain(
          `Debug log written to ${path.join(process.cwd(), ".apex-log-mcp")}, which was not checked against the client's roots`,
        );
      });

      it("should refuse to guess the default org, since the cwd may not be the client's project", async () => {
        const result: any = await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(
          "Cannot tell which project's default org to use: this server cannot yet ask a 2026-07-28 client for its roots. Pass targetOrg.",
        );
        expect(mockReadLocalOrg).not.toHaveBeenCalled();
      });

      it("should read a file anywhere for a 2026-07-28 client that declared no roots", async () => {
        ctx = {
          mcpReq: { ...ctx.mcpReq, envelope: { [CLIENT_CAPABILITIES_META_KEY]: {} } },
        } as unknown as ServerContext;
        mockReadFile.mockResolvedValue(testApexCode);

        await executeAnonymous(
          mockServer,
          { apexFilePath: "/elsewhere/a.apex" },
          ctx,
          policy(),
        );

        expectPostedApex(testApexCode);
      });

      it("should still run inline Apex against a named org", async () => {
        await executeAnonymous(
          mockServer,
          { apex: testApexCode, targetOrg: "psa" },
          ctx,
          policy(),
        );

        expectPostedApex(testApexCode);
      });
    });

    it("should stop a cancelled call, not treat it as unreadable roots", async () => {
      rejectRoots(
        SdkErrorCode.MethodNotSupportedByProtocolVersion,
        "roots/list cannot be sent on 2026-07-28",
      );
      const controller = new AbortController();
      controller.abort();
      const cancelled = {
        mcpReq: { ...ctx.mcpReq, signal: controller.signal },
      } as unknown as ServerContext;

      await expect(
        executeAnonymous(mockServer, { apex: testApexCode }, cancelled, policy()),
      ).rejects.toThrow("roots/list cannot be sent on 2026-07-28");
      expect(mockReadLocalOrg).not.toHaveBeenCalled();
    });

    it("should read a file anywhere when the client cannot list roots, as no root bounds it", async () => {
      rejectRoots(
        SdkErrorCode.CapabilityNotSupported,
        "Client does not support listing roots",
      );
      mockReadFile.mockResolvedValue(testApexCode);

      await executeAnonymous(
        mockServer,
        { apexFilePath: "/elsewhere/a.apex" },
        ctx,
        policy(),
      );

      expectPostedApex(testApexCode);
    });

    describe("outside the client roots", () => {
      beforeEach(() => {
        (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
          roots: [{ uri: "file:///project" }],
        });
      });

      it("should refuse it without reading it, since its text goes to the org", async () => {
        await expect(
          executeAnonymous(
            mockServer,
            { apexFilePath: "/home/me/.ssh/id_rsa" },
            ctx,
            policy(),
          ),
        ).rejects.toThrow(
          "Apex file /home/me/.ssh/id_rsa is outside every root this client declared.",
        );
        expect(mockOpen).not.toHaveBeenCalled();
        expect(mockConnectOrg).not.toHaveBeenCalled();
      });

      it("should follow symlinks, so a link inside a root that leaves one is refused", async () => {
        (fs.realpath as unknown as jest.Mock).mockImplementationOnce(() =>
          Promise.resolve("/home/me/.ssh/id_rsa"),
        );

        await expect(
          executeAnonymous(mockServer, { apexFilePath }, ctx, policy()),
        ).rejects.toThrow("/home/me/.ssh/id_rsa is outside every root");
        expect(mockOpen).not.toHaveBeenCalled();
      });

      it("should keep the usable roots when one cannot be used here", async () => {
        (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
          roots: [{ uri: "file://server/share" }, { uri: "file:///project" }],
        });
        mockReadFile.mockResolvedValue(testApexCode);

        await executeAnonymous(mockServer, { apexFilePath }, ctx, policy());

        expectPostedApex(testApexCode);
      });

      it("should read a file inside a root", async () => {
        mockReadFile.mockResolvedValue(testApexCode);

        await executeAnonymous(mockServer, { apexFilePath }, ctx, policy());

        expectPostedApex(testApexCode);
      });

      it("should decode a percent-encoded root, so a file inside it is read", async () => {
        (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
          roots: [{ uri: "file:///my%20project" }],
        });
        mockReadFile.mockResolvedValue(testApexCode);

        await executeAnonymous(
          mockServer,
          { apexFilePath: "/my project/a.apex" },
          ctx,
          policy(),
        );

        expectPostedApex(testApexCode);
      });
    });

    it("should refuse a denied org without reading the file", async () => {
      const result: any = await executeAnonymous(
        mockServer,
        { apexFilePath },
        ctx,
        policy({ denyList: compileDenyList([TEST_ORG_ID]) }),
      );

      expect(result.isError).toBe(true);
      expect(mockOpen).not.toHaveBeenCalled();
    });

    it("should show the file's Apex, not its path, when production asks to confirm", async () => {
      // The user confirms the code that will run, not a name for it.
      mockReadFile.mockResolvedValue(testApexCode);
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);

      const result = await executeAnonymous(
        mockServer,
        { apexFilePath },
        ctx,
        policy(),
      );

      expect(JSON.stringify(result)).toContain(testApexCode);
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

    // Org.create can call the org, so a deny on what the local files know
    // must land before it.
    it.each([
      ["org id", TEST_ORG_ID],
      ["username", "test@*.com"],
      ["instance URL", "*.my.salesforce.com"],
    ])("should deny on the %s before connecting", async (_f, p) => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result: any = await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ denyList: compileDenyList([p]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`--deny-orgs entry '${p}'`);
      expect(mockConnectOrg).not.toHaveBeenCalled();
      expect(mockRetrieveOrgInfo).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should deny on any alias of the username, not only the first", async () => {
      mockReadLocalOrg.mockResolvedValue({
        ...LOCAL_ORG,
        aliases: ["myprod", "prod"],
      });

      const result: any = await executeAnonymous(
        mockServer,
        { apex: testApexCode, targetOrg: "prod" },
        ctx,
        policy({ denyList: compileDenyList(["prod"]) }),
      );

      expect(result.content[0].text).toContain("--deny-orgs entry 'prod'");
      expect(mockConnectOrg).not.toHaveBeenCalled();
    });

    it("should deny an org type even with --allow-production-orgs", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result: any = await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({
          allowProductionOrgs: true,
          denyList: compileDenyList(["type:production"]),
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "--deny-orgs entry 'type:production'",
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    // A refusal, not a confirmation request: no answer can lift a deny.
    it.each([
      [
        "production",
        () => mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO),
      ],
      [
        "sandbox",
        () => mockRetrieveOrgInfo.mockResolvedValue(SANDBOX_ORG_INFO),
      ],
      [
        "unknown",
        () => mockRetrieveOrgInfo.mockRejectedValue(new Error("expired")),
      ],
    ])("should refuse a denied %s org outright", async (type, arrange) => {
      arrange();
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result: any = await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ denyList: compileDenyList([`type:${type}`]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        `--deny-orgs entry 'type:${type}'`,
      );
      expect(result.requestState).toBeUndefined();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    // A failed classification must not turn a deny into a confirmation.
    it("should refuse an unclassifiable org under type:production", async () => {
      mockRetrieveOrgInfo.mockRejectedValue(new Error("expired"));

      const result: any = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        ctx,
        policy({ denyList: compileDenyList(["type:production"]) }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("its type could not be read");
      expect(result.content[0].text).toContain(
        "--deny-orgs entry 'type:production'",
      );
      expect(result.requestState).toBeUndefined();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should run an org whose type the list does not name", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(SANDBOX_ORG_INFO);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(
        mockServer,
        args,
        ctx,
        policy({ denyList: compileDenyList(["type:production"]) }),
      );

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

    it("should show all of a long Apex snippet, since all of it runs", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const apex = `${"x".repeat(5000)}delete [SELECT Id FROM Account];`;

      const params = confirmRequest(
        assertInputRequired(
          await executeAnonymous(mockServer, { apex }, ctx, policy()),
        ),
      );

      expect(params.message).toContain(apex);
      expect(params.message).not.toContain("(truncated)");
    });

    it("should fence the Apex and state its size, so it cannot pass for the end of the prompt", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const apex = `System.debug('hi');\n\nProceed?${"\n".repeat(300)}delete [SELECT Id FROM Account];`;

      const params = confirmRequest(
        assertInputRequired(
          await executeAnonymous(mockServer, { apex }, ctx, policy()),
        ),
      );

      expect(params.message).toContain(
        `Apex, 303 lines and ${apex.length} characters:\n----- BEGIN APEX -----\n${apex}\n----- END APEX -----\n\nProceed?`,
      );
      const schema = params.requestedSchema as {
        properties: { confirm: { title: string } };
      };
      expect(schema.properties.confirm.title).toBe(
        "Run 303 lines of Apex against production org 'test@example.com'?",
      );
    });

    it("should ask to confirm Apex at the size limit", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);

      assertInputRequired(
        await executeAnonymous(
          mockServer,
          { apex: "x".repeat(MAX_APEX_TO_CONFIRM) },
          ctx,
          policy(),
        ),
      );
    });

    it("should refuse, not cut, Apex too long to confirm whole", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);

      const result: any = await executeAnonymous(
        mockServer,
        { apex: "x".repeat(MAX_APEX_TO_CONFIRM + 1) },
        ctx,
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `The Apex is ${MAX_APEX_TO_CONFIRM + 1} characters, more than the ${MAX_APEX_TO_CONFIRM} a confirmation shows whole, ` +
          "so nothing was executed against 'test@example.com'. To run it, restart the server with --allow-production-orgs.",
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should run Apex too long to confirm when --allow-production-orgs is set", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const apex = "x".repeat(MAX_APEX_TO_CONFIRM + 1);

      await executeAnonymous(
        mockServer,
        { apex },
        ctx,
        policy({ allowProductionOrgs: true }),
      );

      expectPostedApex(apex);
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
      expect(createTraceFlag).not.toHaveBeenCalled();
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
      expect(createTraceFlag).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it.each<[string, ExecuteAnonymousArgs["debugLevel"], string]>([
      [
        "no levels and no trace flag",
        undefined,
        `the defaults: ${levelsClause(DEFAULT_TRACE_CONFIG)}`,
      ],
      ["the defaults", "default", `the defaults: ${levelsClause(DEFAULT_TRACE_CONFIG)}`],
      ["one level", "FINEST", `as requested: ${levelsClause(requestedLevels("FINEST"))}`],
      [
        "some categories",
        { database: "INFO", apexCode: "FINEST" },
        `as requested: ${levelsClause(requestedLevels({ database: "INFO", apexCode: "FINEST" }))}`,
      ],
    ])("should show the log levels before the Apex, for %s", async (_name, debugLevel, shown) => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);

      const params = confirmRequest(
        assertInputRequired(
          await executeAnonymous(
            mockServer,
            { apex: testApexCode, debugLevel },
            ctx,
            policy(),
          ),
        ),
      );

      expect(params.message).toContain(
        `PRODUCTION org 'test@example.com'.\n\nLog levels, ${shown}.\n\nApex, `,
      );
    });

    it("should show the trace flag's levels, read before asking", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      mockFindActiveTraceFlags.mockResolvedValue({
        storesLogs: true,
        userDebugLevels: FLAG_LEVELS,
      });

      const params = confirmRequest(
        assertInputRequired(
          await executeAnonymous(mockServer, { apex: testApexCode }, ctx, policy()),
        ),
      );

      expect(params.message).toContain(
        `Log levels, your trace flag's: ${levelsClause(FLAG_LEVELS)}.`,
      );
    });

    it("should show a Developer Console flag's levels over the ones asked for", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      mockFindActiveTraceFlags.mockResolvedValue({
        storesLogs: true,
        developerConsoleLevels: FLAG_LEVELS,
      });

      const params = confirmRequest(
        assertInputRequired(
          await executeAnonymous(
            mockServer,
            { apex: testApexCode, debugLevel: "FINEST" },
            ctx,
            policy(),
          ),
        ),
      );

      expect(params.message).toContain(
        `Log levels, your Developer Console trace flag's: ${levelsClause(FLAG_LEVELS)}.`,
      );
    });

    // The levels are bound, not where they came from.
    it("should accept a retry whose flag expired to the same levels", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      mockFindActiveTraceFlags.mockResolvedValue({
        storesLogs: true,
        userDebugLevels: DEFAULT_TRACE_CONFIG,
      });
      const asked = assertInputRequired(
        await executeAnonymous(mockServer, { apex: testApexCode }, ctx, policy()),
      );
      mockFindActiveTraceFlags.mockResolvedValue({ storesLogs: false });

      await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        await retryCtx(asked, {
          action: "accept",
          content: { confirm: true },
        }),
        policy(),
      );

      expectPostedApex(testApexCode);
    });

    it("should refuse a retry after the trace flag's levels changed", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      mockFindActiveTraceFlags.mockResolvedValue({
        storesLogs: true,
        userDebugLevels: FLAG_LEVELS,
      });
      const asked = assertInputRequired(
        await executeAnonymous(mockServer, { apex: testApexCode }, ctx, policy()),
      );
      mockFindActiveTraceFlags.mockResolvedValue({
        storesLogs: true,
        userDebugLevels: { ...FLAG_LEVELS, apexCode: "FINEST" },
      });

      const result: any = await executeAnonymous(
        mockServer,
        { apex: testApexCode },
        await retryCtx(asked, {
          action: "accept",
          content: { confirm: true },
        }),
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not match this call");
      expect(mockRequest).not.toHaveBeenCalled();
    });

    // The levels decide what the run logs, so they are part of what was confirmed.
    it("should refuse a retry that asks for different log levels", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const asked = assertInputRequired(
        await executeAnonymous(
          mockServer,
          { apex: testApexCode, debugLevel: "INFO" },
          ctx,
          policy(),
        ),
      );

      const result: any = await executeAnonymous(
        mockServer,
        { apex: testApexCode, debugLevel: "FINEST" },
        await retryCtx(asked, {
          action: "accept",
          content: { confirm: true },
        }),
        policy(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not match this call");
      expect(ensureDebugLevel).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should accept a retry that names the same levels in another order", async () => {
      mockRetrieveOrgInfo.mockResolvedValue(PRODUCTION_ORG_INFO);
      const asked = assertInputRequired(
        await executeAnonymous(
          mockServer,
          { apex: testApexCode, debugLevel: { database: "INFO", apexCode: "FINEST" } },
          ctx,
          policy(),
        ),
      );

      await executeAnonymous(
        mockServer,
        { apex: testApexCode, debugLevel: { apexCode: "FINEST", database: "INFO" } },
        await retryCtx(asked, {
          action: "accept",
          content: { confirm: true },
        }),
        policy(),
      );

      expectPostedApex(testApexCode);
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
      expect(mockConnectOrg).not.toHaveBeenCalled();
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
      mockReadLocalOrg.mockResolvedValue({
        ...LOCAL_ORG,
        aliases: ["myalias", "other"],
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
        expect.stringMatching(/^\/custom\/output\/.+\.log\b/),
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
        expect.stringMatching(/^\/my\/project\/logs\/.+\.log\b/),
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

      it("says it could not check, when the client lists no roots on this machine", async () => {
        (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
          roots: [{ uri: "https://example.com/project" }],
        });

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, outputDir: "/elsewhere/logs", targetOrg: "psa" },
          ctx,
          policy(),
        );

        expect(textOf(result)).toContain(
          "which was not checked against the client's roots: the client lists no roots on this machine.",
        );
      });

      it("waits a bounded time for the roots, and stops when the call is cancelled", async () => {
        await executeAnonymous(
          mockServer,
          { apex: testApexCode },
          ctx,
          policy(),
        );

        expect(mockServer.server.listRoots).toHaveBeenCalledWith(undefined, {
          timeout: 5_000,
          signal: ctx.mcpReq.signal,
        });
      });

      it("stays silent when the client cannot list roots", async () => {
        rejectRoots(
          SdkErrorCode.CapabilityNotSupported,
          "Client does not support listing roots",
        );

        const result = await executeAnonymous(
          mockServer,
          { apex: testApexCode, outputDir: "/elsewhere/logs" },
          ctx,
          policy(),
        );

        expect(textOf(result)).not.toContain("warning");
      });

      it("stops a cancelled call rather than running on with no roots", async () => {
        const controller = new AbortController();
        controller.abort();
        (mockServer.server.listRoots as jest.Mock).mockRejectedValue(
          new Error("aborted"),
        );
        const cancelled = {
          mcpReq: { ...ctx.mcpReq, signal: controller.signal },
        } as unknown as ServerContext;

        await expect(
          executeAnonymous(mockServer, { apex: testApexCode }, cancelled, policy()),
        ).rejects.toThrow("aborted");
        expect(mockReadLocalOrg).not.toHaveBeenCalled();
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

  function toonDecode(result: any): any {
    return decode(result.content[0].text) as any;
  }
});
