/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Connection } from "jsforce";
import { ensureTraceFlag } from "../../src/salesforce/traceFlags";

describe("Trace Flags", () => {
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

  describe("ensureTraceFlag", () => {
    const tracedEntityId = "000000000000000000";
    const traceFlagId = "100000000000000000";
    const debugLevelId = "200000000000000000";
    const now = "2025-01-15T09:00:00.000Z";
    const tomorrow = "2025-01-16T09:00:00.000Z";

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(now));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should not create trace flag when active one already exists", async () => {
      const existingTraceFlag = {
        Id: traceFlagId,
        TracedEntityId: tracedEntityId,
        DebugLevelId: debugLevelId,
        StartDate: now,
        ExpirationDate: tomorrow,
      };

      mockQuery.mockResolvedValue({
        records: [existingTraceFlag],
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT Id, TracedEntityId, DebugLevelId, StartDate, ExpirationDate")
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("FROM TraceFlag")
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(`WHERE TracedEntityId = '${tracedEntityId}'`)
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("AND LogType = 'USER_DEBUG'")
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("should create new trace flag when none exists", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockQuery).toHaveBeenCalled();
      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(mockCreate).toHaveBeenCalledWith({
        TracedEntityId: tracedEntityId,
        DebugLevelId: debugLevelId,
        StartDate: now,
        ExpirationDate: tomorrow,
        LogType: "USER_DEBUG",
      });
    });

    it("should set expiration date 24 hours from now", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          StartDate: now,
          ExpirationDate: tomorrow,
        })
      );
    });

    it("should include errors in error message when creation fails", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: false,
        errors: ["Error 1", "Error 2"],
      });

      try {
        await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);
        fail("Expected error to be thrown");
      } catch (error: any) {
        expect(error.message).toContain("Failed to create TraceFlag");
        expect(error.message).toContain("Error 1");
        expect(error.message).toContain("Error 2");
      }
    });

    it("should handle query errors gracefully", async () => {
      const queryError = new Error("Query failed");
      mockQuery.mockRejectedValue(queryError);

      await expect(
        ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId)
      ).rejects.toThrow("Query failed");
    });

    it("should handle creation errors gracefully", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      const createError = new Error("Network error");
      mockCreate.mockRejectedValue(createError);

      await expect(
        ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId)
      ).rejects.toThrow("Network error");
    });

    it("should query for active trace flags only (ExpirationDate > now)", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      const queryCall = mockQuery.mock.calls[0][0];
      expect(queryCall).toContain(`ExpirationDate > ${now}`);
    });

    it("should query with LIMIT 1 for efficiency", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 1")
      );
    });

    it("should only query for USER_DEBUG log type", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("AND LogType = 'USER_DEBUG'")
      );
    });

    it("should create trace flag with USER_DEBUG log type", async () => {
      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          LogType: "USER_DEBUG",
        })
      );
    });

    it("should use provided traced entity ID and debug level ID", async () => {
      const customTracedEntityId = "customEntity";
      const customDebugLevelId = "customDebug";

      mockQuery.mockResolvedValue({
        records: [],
      });

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(
        mockConnection,
        customTracedEntityId,
        customDebugLevelId
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(`WHERE TracedEntityId = '${customTracedEntityId}'`)
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          TracedEntityId: customTracedEntityId,
          DebugLevelId: customDebugLevelId,
        })
      );
    });

    it("should not throw error when active trace flag exists", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: traceFlagId,
            TracedEntityId: tracedEntityId,
            DebugLevelId: debugLevelId,
            StartDate: now,
            ExpirationDate: tomorrow,
          },
        ],
      });

      await expect(
        ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId)
      ).resolves.not.toThrow();
    });
  });
});
