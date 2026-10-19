/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Connection } from "@salesforce/core";
import {
  createTraceFlag,
  deleteTraceFlag,
  findActiveTraceFlags,
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
  let mockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));

    mockCreate = jest.fn();
    mockDestroy = jest.fn();
    mockQuery = jest.fn();
    mockSobject = jest.fn().mockReturnValue({
      create: mockCreate,
      destroy: mockDestroy,
    });

    mockConnection = {
      tooling: { sobject: mockSobject, query: mockQuery },
    } as unknown as jest.Mocked<Connection>;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("findActiveTraceFlags", () => {
    const flagLevels = {
      ApexCode: "ERROR",
      ApexProfiling: "NONE",
      Callout: "NONE",
      Database: "INFO",
      Nba: "NONE",
      System: "WARN",
      Validation: "NONE",
      Visualforce: "NONE",
      Wave: "NONE",
      Workflow: "NONE",
    };

    it("gives the levels of each live flag, by log type", async () => {
      mockQuery.mockResolvedValue({
        records: [
          { LogType: "DEVELOPER_LOG", DebugLevel: { ...flagLevels, ApexCode: "FINEST" } },
          { LogType: "USER_DEBUG", DebugLevel: flagLevels },
        ],
      });

      const flags = await findActiveTraceFlags(mockConnection, tracedEntityId);

      expect(flags.storesLogs).toBe(true);
      expect(flags.userDebugLevels).toMatchObject({
        apexCode: "ERROR",
        database: "INFO",
        system: "WARN",
        workflow: "NONE",
      });
      expect(flags.developerConsoleLevels).toMatchObject({ apexCode: "FINEST" });
    });

    // A concurrent run's flag, or one a failed delete left, is the tool's, not the user's.
    it("stores logs but gives no levels for the tool's own run flag", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            LogType: "USER_DEBUG",
            DebugLevel: { ...flagLevels, DeveloperName: "Apex_Log_MCP_Debug_Level" },
          },
        ],
      });

      await expect(
        findActiveTraceFlags(mockConnection, tracedEntityId),
      ).resolves.toEqual({ storesLogs: true, userDebugLevels: undefined });
    });

    // Its levels beat the header, so they are the run's, but they are not the user's flag.
    it("stores logs and gives its own levels for a Developer Console flag alone", async () => {
      mockQuery.mockResolvedValue({
        records: [{ LogType: "DEVELOPER_LOG", DebugLevel: flagLevels }],
      });

      const flags = await findActiveTraceFlags(mockConnection, tracedEntityId);

      expect(flags.storesLogs).toBe(true);
      expect(flags.userDebugLevels).toBeUndefined();
      expect(flags.developerConsoleLevels).toMatchObject({ apexCode: "ERROR" });
    });

    it("stores nothing when the entity has no live flag", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await expect(
        findActiveTraceFlags(mockConnection, tracedEntityId),
      ).resolves.toEqual({ storesLogs: false, userDebugLevels: undefined });
    });

    // Live now, and of a type that stores the log, with the levels in the same query.
    it("asks for the entity's live USER_DEBUG and DEVELOPER_LOG flags and their levels", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await findActiveTraceFlags(mockConnection, tracedEntityId);

      const query = mockQuery.mock.calls[0]?.[0] as string;
      expect(query).toContain("FROM TraceFlag");
      expect(query).toContain(`TracedEntityId = '${tracedEntityId}'`);
      // A flag saved with no StartDate is live from the start.
      expect(query).toContain(`(StartDate = null OR StartDate <= ${now})`);
      expect(query).toContain(`ExpirationDate > ${now}`);
      expect(query).toContain("LogType IN ('USER_DEBUG', 'DEVELOPER_LOG')");
      Object.keys(flagLevels).forEach((field) =>
        expect(query).toContain(`DebugLevel.${field}`),
      );
    });

    it("passes a query error on", async () => {
      mockQuery.mockRejectedValue(new Error("Query failed"));

      await expect(
        findActiveTraceFlags(mockConnection, tracedEntityId),
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
