/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Connection } from "@salesforce/core";
import {
  createTraceFlag,
  deleteTraceFlag,
  hasActiveTraceFlag,
} from "../../src/salesforce/traceFlags";

describe("Trace Flags", () => {
  const tracedEntityId = "000000000000000000";
  const traceFlagId = "100000000000000000";
  const debugLevelId = "200000000000000000";
  const now = "2025-01-15T09:00:00.000Z";

  let mockConnection: jest.Mocked<Connection>;
  let mockSobject: jest.Mock;
  let mockCreate: jest.Mock;
  let mockDestroy: jest.Mock;
  let mockFindOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));

    mockCreate = jest.fn();
    mockDestroy = jest.fn();
    mockFindOne = jest.fn();
    mockSobject = jest.fn().mockReturnValue({
      create: mockCreate,
      destroy: mockDestroy,
      findOne: mockFindOne,
    });

    mockConnection = {
      tooling: { sobject: mockSobject },
    } as unknown as jest.Mocked<Connection>;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("hasActiveTraceFlag", () => {
    it("is true when the entity has a live flag", async () => {
      mockFindOne.mockResolvedValue({ Id: traceFlagId });

      await expect(
        hasActiveTraceFlag(mockConnection, tracedEntityId),
      ).resolves.toBe(true);
    });

    it("is false when the entity has none", async () => {
      mockFindOne.mockResolvedValue(null);

      await expect(
        hasActiveTraceFlag(mockConnection, tracedEntityId),
      ).resolves.toBe(false);
    });

    // Live now, and of a type that stores the log: a Developer Console flag counts.
    it("asks for USER_DEBUG and DEVELOPER_LOG flags on the entity that are live now", async () => {
      mockFindOne.mockResolvedValue(null);

      await hasActiveTraceFlag(mockConnection, tracedEntityId);

      const [conditions, fields] = mockFindOne.mock.calls[0] ?? [];
      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(fields).toEqual(["Id"]);
      expect(conditions.TracedEntityId).toBe(tracedEntityId);
      expect(String(conditions.StartDate.$lte)).toBe(now);
      expect(String(conditions.ExpirationDate.$gt)).toBe(now);
      expect(conditions.LogType).toEqual({
        $in: ["USER_DEBUG", "DEVELOPER_LOG"],
      });
    });

    it("passes a query error on", async () => {
      mockFindOne.mockRejectedValue(new Error("Query failed"));

      await expect(
        hasActiveTraceFlag(mockConnection, tracedEntityId),
      ).rejects.toThrow("Query failed");
    });
  });

  describe("createTraceFlag", () => {
    // Started back by the clock skew, so an org clock behind this one still sees it live.
    it("creates a USER_DEBUG flag from 5 minutes back until the duration ends", async () => {
      mockCreate.mockResolvedValue({ success: true, id: traceFlagId });

      await expect(
        createTraceFlag(mockConnection, tracedEntityId, debugLevelId, 900_000),
      ).resolves.toBe(traceFlagId);

      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(mockCreate).toHaveBeenCalledWith({
        TracedEntityId: tracedEntityId,
        DebugLevelId: debugLevelId,
        StartDate: "2025-01-15T08:55:00.000Z",
        ExpirationDate: "2025-01-15T09:15:00.000Z",
        LogType: "USER_DEBUG",
      });
    });

    it("names the errors when Salesforce refuses the flag", async () => {
      mockCreate.mockResolvedValue({
        success: false,
        errors: ["Error 1", "Error 2"],
      });

      const created = createTraceFlag(
        mockConnection,
        tracedEntityId,
        debugLevelId,
        900_000,
      );

      await expect(created).rejects.toThrow("Failed to create TraceFlag");
      await expect(created).rejects.toThrow(/Error 1.*Error 2/);
    });

    it("passes a network error on", async () => {
      mockCreate.mockRejectedValue(new Error("Network error"));

      await expect(
        createTraceFlag(mockConnection, tracedEntityId, debugLevelId, 900_000),
      ).rejects.toThrow("Network error");
    });
  });

  describe("deleteTraceFlag", () => {
    it("deletes the flag by id", async () => {
      mockDestroy.mockResolvedValue({ success: true, id: traceFlagId });

      await deleteTraceFlag(mockConnection, traceFlagId);

      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(mockDestroy).toHaveBeenCalledWith(traceFlagId);
    });

    it("names the errors when Salesforce refuses the delete", async () => {
      mockDestroy.mockResolvedValue({ success: false, errors: ["Locked"] });

      await expect(
        deleteTraceFlag(mockConnection, traceFlagId),
      ).rejects.toThrow(/Failed to delete TraceFlag.*Locked/);
    });
  });
});
