/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import fs from "node:fs";
import path from "node:path";

import { Connection } from "@salesforce/core";
import {
  ensureDebugLevel,
  levelsClause,
  requestedLevels,
  toTraceConfig,
  CATEGORY_LOG_NAMES,
  DEFAULT_TRACE_CONFIG,
  LOG_CATEGORIES,
  TRACE_CATEGORIES,
} from "../../src/salesforce/debugLevels";

describe("Debug Levels", () => {
  const testId = "000000000000000000";

  let mockConnection: jest.Mocked<Connection>;
  let mockTooling: any;
  let mockQuery: any;
  let mockSobject: any;
  let mockCreate: any;
  let mockUpdate: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();
    mockCreate = jest.fn();
    mockUpdate = jest.fn();
    mockSobject = jest.fn();

    mockTooling = {
      query: mockQuery,
      sobject: mockSobject,
    };

    mockSobject.mockReturnValue({
      create: mockCreate,
      update: mockUpdate,
    });

    mockConnection = {
      tooling: mockTooling,
    } as any;
  });

  const allDefaults = {
    ApexCode: "FINE",
    ApexProfiling: "FINE",
    Callout: "DEBUG",
    Database: "FINEST",
    Nba: "INFO",
    System: "DEBUG",
    Validation: "DEBUG",
    Visualforce: "FINE",
    Wave: "INFO",
    Workflow: "FINE",
  };

  describe("ensureDebugLevel", () => {
    // The header sets every run's levels, so the record's own never need changing.
    it("should return the existing record without writing to it", async () => {
      mockQuery.mockResolvedValue({ records: [{ Id: testId }] });

      await expect(ensureDebugLevel(mockConnection)).resolves.toBe(testId);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("should create one at the defaults when none exists", async () => {
      mockQuery.mockResolvedValue({ records: [] });
      mockCreate.mockResolvedValue({ success: true, id: testId });

      await expect(ensureDebugLevel(mockConnection)).resolves.toBe(testId);
      expect(mockCreate).toHaveBeenCalledWith({
        DeveloperName: "Apex_Log_MCP_Debug_Level",
        MasterLabel: "Apex_Log_MCP_Debug_Level",
        ...allDefaults,
      });
    });

    it("should query by DeveloperName with LIMIT 1", async () => {
      mockQuery.mockResolvedValue({ records: [{ Id: testId }] });

      await ensureDebugLevel(mockConnection);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("WHERE DeveloperName = 'Apex_Log_MCP_Debug_Level'");
      expect(query).toContain("LIMIT 1");
    });

    it("should throw when creation fails", async () => {
      mockQuery.mockResolvedValue({ records: [] });
      mockCreate.mockResolvedValue({ success: false, errors: ["Creation failed"] });

      await expect(ensureDebugLevel(mockConnection)).rejects.toThrow(
        "Failed to create DebugLevel",
      );
    });

    it("should throw when creation returns no ID", async () => {
      mockQuery.mockResolvedValue({ records: [] });
      mockCreate.mockResolvedValue({ success: true, id: null });

      await expect(ensureDebugLevel(mockConnection)).rejects.toThrow(
        "Failed to create DebugLevel",
      );
    });

    it("should propagate query errors", async () => {
      mockQuery.mockRejectedValue(new Error("Query failed"));

      await expect(ensureDebugLevel(mockConnection)).rejects.toThrow("Query failed");
    });
  });

  describe("toTraceConfig", () => {
    it("should read an empty field, or no record, as the defaults", () => {
      expect(toTraceConfig({ ApexCode: "ERROR", Nba: null })).toEqual({
        ...DEFAULT_TRACE_CONFIG,
        apexCode: "ERROR",
      });
      expect(toTraceConfig(null)).toEqual(DEFAULT_TRACE_CONFIG);
    });

    it("should read every category from a DebugLevel record's fields", () => {
      expect(
        toTraceConfig({ ...allDefaults, ApexCode: "ERROR", Database: "INFO" }),
      ).toEqual({ ...DEFAULT_TRACE_CONFIG, apexCode: "ERROR", database: "INFO" });
    });
  });

  describe("requestedLevels", () => {
    it("should set every category to a bare level", () => {
      const levels = requestedLevels("FINEST");

      TRACE_CATEGORIES.forEach((category) => expect(levels[category]).toBe("FINEST"));
    });

    it("should set the categories an object names over the defaults", () => {
      expect(requestedLevels({ apexCode: "ERROR" })).toEqual({
        ...DEFAULT_TRACE_CONFIG,
        apexCode: "ERROR",
      });
    });
  });

  describe("levelsClause", () => {
    it("should group the categories by level, in category order", () => {
      expect(levelsClause(DEFAULT_TRACE_CONFIG)).toBe(
        "apexCode, apexProfiling, visualforce, workflow FINE; callout, system, validation DEBUG; database FINEST; nba, wave INFO",
      );
    });
  });

  describe("log categories", () => {
    const fixtures = path.join(__dirname, "..", "eval", "fixtures");

    it.each(fs.readdirSync(fixtures).filter((name) => name.endsWith(".log")))(
      "spells every category in %s the way the log header does",
      (name) => {
        const header = fs
          .readFileSync(path.join(fixtures, name), "utf8")
          .split("\n")[0]!;
        const categories = header
          .split(" ")[1]!
          .split(";")
          .map((pair) => pair.split(",")[0]!);

        expect(categories.length).toBeGreaterThan(0);
        categories.forEach((category) =>
          expect(LOG_CATEGORIES).toContain(category),
        );
      },
    );

    it("gives every settable category a header spelling", () => {
      TRACE_CATEGORIES.forEach((category) => {
        const spelling =
          category === "database" ? "DB" : toScreamingSnake(category);

        expect(LOG_CATEGORIES).toContain(spelling);
        expect(CATEGORY_LOG_NAMES[category]).toBe(spelling);
      });
    });
  });
});

/** `apexCode` as a log header spells it: `APEX_CODE`. */
function toScreamingSnake(category: string): string {
  return category.replace(/([A-Z])/g, "_$1").toUpperCase();
}
