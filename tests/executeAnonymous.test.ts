/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
} from "@jest/globals";
import {
  executeAnonymous,
  ExecuteAnonymousArgs,
} from "../src/tools/executeAnonymous";

jest.mock("../src/salesforce/users", () => ({
  getUserIdByUsername: jest.fn(),
}));

jest.mock("../src/salesforce/debugLevels", () => ({
  getOrCreateDebugLevelId: jest.fn(),
}));

jest.mock("../src/salesforce/traceFlags", () => ({
  ensureTraceFlag: jest.fn(),
}));

import { getUserIdByUsername } from "../src/salesforce/users";
import { getOrCreateDebugLevelId } from "../src/salesforce/debugLevels";
import { ensureTraceFlag } from "../src/salesforce/traceFlags";

describe("Execute Anonymous", () => {
  const testUserId = "005000000000001";
  const testDebugLevelId = "07L000000000001";
  const testLogId = "07L000000000002";
  const testLogBody = "APEX DEBUG LOG CONTENT HERE";
  const testApexCode = "System.debug('Hello World');";

  let mockConnection: any;
  let mockTooling: any;
  let mockExecuteAnonymous: any;
  let mockQuery: any;
  let mockRequest: any;
  let mockGetUsername: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockExecuteAnonymous = jest.fn();
    mockQuery = jest.fn();
    mockRequest = jest.fn();
    mockGetUsername = jest.fn().mockReturnValue("test@example.com");

    mockTooling = {
      executeAnonymous: mockExecuteAnonymous,
    };

    mockConnection = {
      tooling: mockTooling,
      query: mockQuery,
      request: mockRequest,
      getUsername: mockGetUsername,
      userInfo: {
        id: testUserId,
      },
    };

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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockConnection, args);

      expect(getUserIdByUsername).toHaveBeenCalledWith(
        mockConnection,
        "test@example.com"
      );
      expect(getOrCreateDebugLevelId).toHaveBeenCalledWith(mockConnection);
      expect(ensureTraceFlag).toHaveBeenCalledWith(
        mockConnection,
        testUserId,
        testDebugLevelId
      );
      expect(mockExecuteAnonymous).toHaveBeenCalledWith(testApexCode);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT Id FROM ApexLog")
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(`WHERE LogUserId = '${testUserId}'`)
      );
      expect(mockRequest).toHaveBeenCalledWith(
        `/sobjects/ApexLog/${testLogId}/Body/`
      );
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: testLogBody,
          },
        ],
      });
    });

    it("should throw error when connection username cannot be determined", async () => {
      mockGetUsername.mockReturnValue(null);
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Could not determine username from connection"
      );

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

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Apex could not be compiled at line 1, column 5: Unexpected token 'Invalid'"
      );

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should throw error when apexResult is null", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockExecuteAnonymous.mockResolvedValue(null);

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Cannot read properties of null"
      );

      expect(mockQuery).not.toHaveBeenCalled();
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

      mockQuery.mockResolvedValue({
        records: [],
      });

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Could not retrieve log from anonymous execution"
      );

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should throw error when logResult is null", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockQuery.mockResolvedValue(null);

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Could not retrieve log from anonymous execution"
      );

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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockResolvedValue(testLogBody);

      await executeAnonymous(mockConnection, args);

      const queryCall = mockQuery.mock.calls[0][0];
      expect(queryCall).toContain("ORDER BY StartTime DESC");
      expect(queryCall).toContain("LIMIT 1");
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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockConnection, args);

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(multiLineApex);
      expect(result.content[0].text).toBe(testLogBody);
    });

    it("should propagate errors from getUserIdByUsername", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const userError = new Error("User not found");

      const mockGetUserIdByUsername =
        getUserIdByUsername as jest.MockedFunction<typeof getUserIdByUsername>;
      mockGetUserIdByUsername.mockRejectedValue(userError);

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "User not found"
      );

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

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Failed to create debug level"
      );

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

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Failed to create trace flag"
      );

      expect(mockExecuteAnonymous).not.toHaveBeenCalled();
    });

    it("should handle errors from tooling.executeAnonymous", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const executeError = new Error("Tooling API error");

      mockExecuteAnonymous.mockRejectedValue(executeError);

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Tooling API error"
      );

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("should handle errors from query", async () => {
      const args: ExecuteAnonymousArgs = { apex: testApexCode };
      const queryError = new Error("Query failed");

      mockExecuteAnonymous.mockResolvedValue({
        compiled: true,
        success: true,
        line: -1,
        column: -1,
      });

      mockQuery.mockRejectedValue(queryError);

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Query failed"
      );

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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockRejectedValue(requestError);

      await expect(executeAnonymous(mockConnection, args)).rejects.toThrow(
        "Failed to fetch log body"
      );
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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockResolvedValue(testLogBody);

      await executeAnonymous(mockConnection, args);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(`WHERE LogUserId = '${customUserId}'`)
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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockConnection, args);

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(soqlApex);
      expect(result.content[0].text).toBe(testLogBody);
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

      mockQuery.mockResolvedValue({
        records: [{ Id: testLogId }],
      });

      mockRequest.mockResolvedValue(testLogBody);

      const result = await executeAnonymous(mockConnection, args);

      expect(mockExecuteAnonymous).toHaveBeenCalledWith(dmlApex);
      expect(result.content[0].text).toBe(testLogBody);
    });
  });

  describe("executeAnonymousTool", () => {
    it("should have correct tool definition", async () => {
      const { executeAnonymousTool } = await import(
        "../src/tools/executeAnonymous"
      );

      expect(executeAnonymousTool.name).toBe("execute_anonymous");
      expect(executeAnonymousTool.description).toContain(
        "Execute a snippet of anonymous Apex"
      );
      expect(executeAnonymousTool.inputSchema.type).toBe("object");
      expect(executeAnonymousTool.inputSchema.properties.apex).toBeDefined();
      expect(executeAnonymousTool.inputSchema.properties.apex.type).toBe(
        "string"
      );
      expect(executeAnonymousTool.inputSchema.required).toContain("apex");
    });
  });
});
