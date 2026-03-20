/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("node:fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue({ size: 1024 }),
  },
}));

jest.mock("../src/salesforce/users", () => ({
  getUserIdByUsername: jest.fn(),
}));

jest.mock("../src/salesforce/debugLevels", () => ({
  getOrCreateDebugLevelId: jest.fn(),
}));

jest.mock("../src/salesforce/traceFlags", () => ({
  ensureTraceFlag: jest.fn(),
}));

jest.mock("../src/salesforce/connection", () => ({
  connect: jest.fn(),
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

jest.mock("@modelcontextprotocol/sdk/server/mcp.js");

import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigAggregator, StateAggregator } from "@salesforce/core";
import { decode } from "@toon-format/toon";
import {
  executeAnonymous,
  ExecuteAnonymousArgs,
} from "../src/tools/executeAnonymous";
import { getUserIdByUsername } from "../src/salesforce/users";
import { getOrCreateDebugLevelId } from "../src/salesforce/debugLevels";
import { ensureTraceFlag } from "../src/salesforce/traceFlags";
import { connect } from "../src/salesforce/connection";

const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockStat = fs.stat as jest.MockedFunction<typeof fs.stat>;

const mockConnect = connect as jest.MockedFunction<typeof connect>;
const mockConfigAggregatorCreate = ConfigAggregator.create as jest.Mock;
const mockStateAggregatorGetInstance = StateAggregator.getInstance as jest.Mock;

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

  beforeEach(() => {
    jest.clearAllMocks();

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

    mockConnect.mockResolvedValue(mockConnection);

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

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

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
      expect(decoded.success).toBe(true);
      expect(decoded.exceptionMessage).toBeUndefined();
      expect(decoded.durationMs).toBe(150);
      expect(decoded.tip).toContain(".gitignore");
    });

    it("should throw error when connection username cannot be determined", async () => {
      mockGetUsername.mockReturnValue(null);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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

      await executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]);

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

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
      ).rejects.toThrow("Failed to create trace flag");

      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should handle errors from tooling.executeAnonymous", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const executeError = new Error("Tooling API error");

      mockExecuteAnonymous.mockRejectedValue(executeError);

      await expect(
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
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

      await executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]);

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

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

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

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(dmlApex);
      const decoded = toonDecode(result);
      expect(decoded.filePath).toContain(`${testLogId}.log`);
    });

    it("should throw error when connect() fails (no default org)", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const connectError = new Error(
        "No default org configured. Please set a default org using 'sf config set target-org <username>'.",
      );

      mockConnect.mockRejectedValue(connectError);

      await expect(
        executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]),
      ).rejects.toThrow("No default org configured");

      expect(getUserIdByUsername).not.toHaveBeenCalled();
      expect(getOrCreateDebugLevelId).not.toHaveBeenCalled();
      expect(ensureTraceFlag).not.toHaveBeenCalled();
      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });
  });

  describe("org allowlist", () => {
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

    it("should throw disabled error when allowlist is empty", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(executeAnonymous(mockServer, args, [])).rejects.toThrow(
        "execute_anonymous is disabled. Configure --allowed-orgs to enable it.",
      );

      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should allow any org with ALLOW_ALL_ORGS token", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should resolve DEFAULT_TARGET_ORG and permit matching org", async () => {
      mockConfigAggregatorCreate.mockResolvedValue({
        getPropertyValue: jest.fn().mockReturnValue("test@example.com"),
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "DEFAULT_TARGET_ORG",
      ]);

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
      expect(mockConfigAggregatorCreate).toHaveBeenCalled();
    });

    it("should resolve DEFAULT_TARGET_DEV_HUB and permit matching org", async () => {
      mockConfigAggregatorCreate.mockResolvedValue({
        getPropertyValue: jest.fn().mockReturnValue("test@example.com"),
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "DEFAULT_TARGET_DEV_HUB",
      ]);

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should resolve alias in allowlist to username for matching", async () => {
      mockStateAggregatorGetInstance.mockResolvedValue({
        aliases: {
          resolveUsername: jest.fn((input: string) =>
            input === "myalias" ? "test@example.com" : input,
          ),
          get: jest.fn(() => null),
        },
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, ["myalias"]);

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should allow org when username matches allowlist", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "test@example.com",
      ]);

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
    });

    it("should reject org not in allowlist with clear error", async () => {
      const args: ExecuteAnonymousArgs = {
        apex: testApexCode,
        targetOrg: "production",
      };

      await expect(
        executeAnonymous(mockServer, args, ["dev", "staging"]),
      ).rejects.toThrow(
        'Org "production" is not in the allowed orgs list. Allowed orgs: dev, staging',
      );

      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should validate default org against allowlist", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(
        executeAnonymous(mockServer, args, ["other@example.com"]),
      ).rejects.toThrow(
        'Org "test@example.com" is not in the allowed orgs list. Allowed orgs: other@example.com',
      );

      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should match allowlist case-insensitively", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "TEST@EXAMPLE.COM",
      ]);

      expect(toonDecode(result).filePath).toContain(`${testLogId}.log`);
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

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

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

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

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

      await executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]);

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining(".apex-log-mcp"),
        { recursive: true },
      );
    });

    it("should write log file with logId as filename", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]);

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

      await executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]);

      expect(mockMkdir).toHaveBeenCalledWith("/custom/output", {
        recursive: true,
      });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/custom\/output\/.+\.log$/),
        testLogBody,
        "utf-8",
      );
    });

    it("should default outputDir to .apex-log-mcp in project root", async () => {
      (mockServer.server.listRoots as jest.Mock).mockResolvedValue({
        roots: [{ uri: "file:///my/project" }],
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await executeAnonymous(mockServer, args, ["ALLOW_ALL_ORGS"]);

      expect(mockMkdir).toHaveBeenCalledWith("/my/project/.apex-log-mcp", {
        recursive: true,
      });
    });

    it("should return file size from stat", async () => {
      mockStat.mockResolvedValue({ size: 2048 } as any);

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

      expect(toonDecode(result).fileSizeBytes).toBe(2048);
    });

    it("should include success false and exceptionMessage on runtime failure", async () => {
      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: false,
        line: -1,
        column: -1,
        exceptionMessage:
          "System.NullPointerException: Attempt to de-reference a null object",
      });

      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

      const decoded = toonDecode(result);
      expect(decoded.success).toBe(false);
      expect(decoded.exceptionMessage).toBe(
        "System.NullPointerException: Attempt to de-reference a null object",
      );
      expect(decoded.filePath).toContain(`${testLogId}.log`);
    });

    it("should include gitignore tip in response", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      const result = await executeAnonymous(mockServer, args, [
        "ALLOW_ALL_ORGS",
      ]);

      expect(toonDecode(result).tip).toBe(
        "Add .apex-log-mcp/ to your .gitignore to avoid committing debug logs.",
      );
    });
  });

  describe("executeAnonymousToolConfig", () => {
    it("should have correct tool definition", async () => {
      const { executeAnonymousToolConfig, executeAnonymousInputSchema } =
        await import("../src/tools/executeAnonymous");

      expect(executeAnonymousToolConfig.description).toContain(
        "Execute a snippet of anonymous Apex",
      );
      expect(executeAnonymousInputSchema.apex).toBeDefined();
      expect(executeAnonymousInputSchema.targetOrg).toBeDefined();
      expect(executeAnonymousInputSchema.outputDir).toBeDefined();
      expect(executeAnonymousInputSchema.debugLevel).toBeDefined();
    });
  });

  function toonDecode(result: any): any {
    return decode(result.content[0].text) as any;
  }
});
