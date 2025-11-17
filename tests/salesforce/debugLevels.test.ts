/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Connection } from "jsforce";
import { getOrCreateDebugLevelId } from "../../src/salesforce/debugLevels";

describe("Debug Levels", () => {
  const testId = "000000000000000000";
  
  let mockConnection: jest.Mocked<Connection>;
  let mockTooling: any;
  let mockQuery: any;
  let mockSobject: any;
  let mockCreate: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();
    mockCreate = jest.fn();
    mockSobject = jest.fn();

    mockTooling = {
      query: mockQuery,
      sobject: mockSobject,
    };

    mockSobject.mockReturnValue({
      create: mockCreate,
    });

    mockConnection = {
      tooling: mockTooling,
    } as any;
  });

  describe("getOrCreateDebugLevelId", () => {
    it("should return existing debug level ID when one exists", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testId,
            DeveloperName: "ExistingDebugLevel",
            ApexCode: "FINEST",
            ApexProfiling: "FINEST",
            Database: "FINEST",
          },
        ],
      });

      const result = await getOrCreateDebugLevelId(mockConnection);

      expect(result).toBe(testId);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          "SELECT Id, DeveloperName, ApexCode, ApexProfiling, Database"
        )
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("FROM DebugLevel")
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE ApexCode = 'FINEST'")
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("AND ApexProfiling = 'FINEST'")
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("AND Database = 'FINEST'")
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("should create new debug level when none exists", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: testId,
      });

      const result = await getOrCreateDebugLevelId(mockConnection);

      expect(result).toBe(testId);
      expect(mockQuery).toHaveBeenCalled();
      expect(mockSobject).toHaveBeenCalledWith("DebugLevel");
      expect(mockCreate).toHaveBeenCalledWith({
        DeveloperName: "LANA_MCP_Debug_Level",
        MasterLabel: "LANA_MCP_Debug_Level",
        ApexCode: "FINEST",
        ApexProfiling: "FINEST",
        Callout: "FINEST",
        Database: "FINEST",
        System: "DEBUG",
        Validation: "INFO",
        Visualforce: "INFO",
        Workflow: "INFO",
      });
    });

    it("should handle case when existing debug level ID is null", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: null,
            DeveloperName: "SomeDebugLevel",
          },
        ],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: testId,
      });

      const result = await getOrCreateDebugLevelId(mockConnection);

      expect(result).toBe(testId);
      expect(mockCreate).toHaveBeenCalled();
    });

    it("should throw error when debug level creation fails", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: false,
        errors: ["Creation failed"],
      });

      await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
        "Failed to create DebugLevel"
      );
    });

    it("should throw error when debug level creation returns no ID", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: null,
      });

      await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
        "Failed to create DebugLevel"
      );
    });

    it("should handle query errors gracefully", async () => {
      const queryError = new Error("Query failed");
      mockQuery.mockRejectedValue(queryError);

      await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
        "Query failed"
      );
    });

    it("should handle creation errors gracefully", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      const createError = new Error("Creation failed");
      mockCreate.mockRejectedValue(createError);

      await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
        "Creation failed"
      );
    });

    it("should query with LIMIT 1 for efficiency", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testId,
            DeveloperName: "Test",
            ApexCode: "FINEST",
            ApexProfiling: "FINEST",
            Database: "FINEST",
          },
        ],
      });

      await getOrCreateDebugLevelId(mockConnection);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 1")
      );
    });

    it("should find debug level with all required log levels set to FINEST", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testId,
            DeveloperName: "LANA_MCP_Debug_Level",
            ApexCode: "FINEST",
            ApexProfiling: "FINEST",
            Database: "FINEST",
          },
        ],
      });

      const result = await getOrCreateDebugLevelId(mockConnection);

      expect(result).toBe(testId);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/ApexCode = 'FINEST'/)
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/ApexProfiling = 'FINEST'/)
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/Database = 'FINEST'/)
      );
    });

    it("should create debug level with correct log levels", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: testId,
      });

      await getOrCreateDebugLevelId(mockConnection);

      const createCall = mockCreate.mock.calls[0][0];
      expect(createCall.ApexCode).toBe("FINEST");
      expect(createCall.ApexProfiling).toBe("FINEST");
      expect(createCall.Callout).toBe("FINEST");
      expect(createCall.Database).toBe("FINEST");
      expect(createCall.System).toBe("DEBUG");
      expect(createCall.Validation).toBe("INFO");
      expect(createCall.Visualforce).toBe("INFO");
      expect(createCall.Workflow).toBe("INFO");
    });
  });
});
