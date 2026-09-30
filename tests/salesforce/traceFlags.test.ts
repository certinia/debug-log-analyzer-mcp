/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Connection } from "@salesforce/core";
import {
  createTraceFlag,
  deleteTraceFlag,
  isAlreadyTraced,
} from "../../src/salesforce/traceFlags";

describe("Trace Flags", () => {
  const tracedEntityId = "000000000000000000";
  const traceFlagId = "100000000000000000";
  const debugLevelId = "200000000000000000";

  let mockConnection: jest.Mocked<Connection>;
  let mockSobject: jest.Mock;
  let mockCreate: jest.Mock;
  let mockDestroy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-15T09:00:00.000Z"));

    mockCreate = jest.fn();
    mockDestroy = jest.fn();
    mockSobject = jest.fn().mockReturnValue({
      create: mockCreate,
      destroy: mockDestroy,
    });

    mockConnection = {
      tooling: { sobject: mockSobject },
    } as unknown as jest.Mocked<Connection>;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("createTraceFlag", () => {
    // Started back by the clock skew, so an org clock behind this one still
    // sees the flag live.
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

  describe("isAlreadyTraced", () => {
    const refusal = (errorCode: string, message: string) =>
      Object.assign(new Error(message), { errorCode });

    it("is true for Salesforce's overlapping-flag refusal", () => {
      expect(
        isAlreadyTraced(
          refusal(
            "FIELD_INTEGRITY_EXCEPTION",
            "This entity is already being traced by a trace flag with a start and expiration date that overlap this trace flag's start and expiration date.: Traced Entity ID",
          ),
        ),
      ).toBe(true);
    });

    it("is false for any other refusal", () => {
      expect(
        isAlreadyTraced(
          refusal("FIELD_INTEGRITY_EXCEPTION", "Expiration date too far"),
        ),
      ).toBe(false);
      expect(isAlreadyTraced(new Error("Network error"))).toBe(false);
      expect(isAlreadyTraced("already being traced")).toBe(false);
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
