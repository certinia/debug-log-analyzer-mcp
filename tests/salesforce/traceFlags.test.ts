/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Connection } from "@salesforce/core";
import { ensureTraceFlag } from "../../src/salesforce/traceFlags";

describe("Trace Flags", () => {
  let mockConnection: jest.Mocked<Connection>;
  let mockTooling: any;
  let mockSobject: any;
  let mockCreate: any;
  let mockFindOne: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCreate = jest.fn();
    mockFindOne = jest.fn();
    mockSobject = jest.fn().mockReturnValue({
      create: mockCreate,
      findOne: mockFindOne,
    });

    mockTooling = {
      sobject: mockSobject,
    };

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
    const userDebug = "USER_DEBUG";

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

      mockFindOne.mockResolvedValue(existingTraceFlag);

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(mockFindOne).toHaveBeenCalledWith(
        {
          TracedEntityId: tracedEntityId,
          ExpirationDate: {
            $gt: expect.objectContaining({
              toString: expect.any(Function),
            }),
          },
          LogType: userDebug,
        },
        ["Id", "TracedEntityId", "DebugLevelId", "StartDate", "ExpirationDate"],
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("should create new trace flag when none exists", async () => {
      mockFindOne.mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(mockCreate).toHaveBeenCalledWith({
        TracedEntityId: tracedEntityId,
        DebugLevelId: debugLevelId,
        StartDate: now,
        ExpirationDate: tomorrow,
        LogType: userDebug,
      });
    });

    it("should set expiration date 24 hours from now", async () => {
      mockFindOne.mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          StartDate: now,
          ExpirationDate: tomorrow,
        }),
      );
    });

    it("should include errors in error message when creation fails", async () => {
      mockFindOne.mockResolvedValue(null);

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
      mockFindOne.mockRejectedValue(queryError);

      await expect(
        ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId),
      ).rejects.toThrow("Query failed");
    });

    it("should handle creation errors gracefully", async () => {
      mockFindOne.mockResolvedValue(null);

      const createError = new Error("Network error");
      mockCreate.mockRejectedValue(createError);

      await expect(
        ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId),
      ).rejects.toThrow("Network error");
    });

    it("should query for active trace flags only (ExpirationDate > now)", async () => {
      mockFindOne.mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          ExpirationDate: {
            $gt: expect.objectContaining({
              toString: expect.any(Function),
            }),
          },
        }),
        expect.any(Array),
      );
    });

    it("should only query for USER_DEBUG log type", async () => {
      mockFindOne.mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          LogType: userDebug,
        }),
        expect.any(Array),
      );
    });

    it("should create trace flag with USER_DEBUG log type", async () => {
      mockFindOne.mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          LogType: userDebug,
        }),
      );
    });

    it("should use provided traced entity ID and debug level ID", async () => {
      const customTracedEntityId = "customEntity";
      const customDebugLevelId = "customDebug";

      mockFindOne.mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        success: true,
        id: traceFlagId,
      });

      await ensureTraceFlag(
        mockConnection,
        customTracedEntityId,
        customDebugLevelId,
      );

      expect(mockFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          TracedEntityId: customTracedEntityId,
        }),
        expect.any(Array),
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          TracedEntityId: customTracedEntityId,
          DebugLevelId: customDebugLevelId,
        }),
      );
    });

    it("should not throw error when active trace flag exists", async () => {
      mockFindOne.mockResolvedValue({
        Id: traceFlagId,
        TracedEntityId: tracedEntityId,
        DebugLevelId: debugLevelId,
        StartDate: now,
        ExpirationDate: tomorrow,
      });

      await expect(
        ensureTraceFlag(mockConnection, tracedEntityId, debugLevelId),
      ).resolves.not.toThrow();
    });
  });
});
