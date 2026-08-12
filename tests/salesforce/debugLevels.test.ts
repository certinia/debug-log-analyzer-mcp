/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import fs from "node:fs";
import path from "node:path";

import { Connection } from "@salesforce/core";
import {
  getOrCreateDebugLevelId,
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

  describe("getOrCreateDebugLevelId", () => {
    describe("when no debug level exists", () => {
      beforeEach(() => {
        mockQuery.mockResolvedValue({ records: [] });
        mockCreate.mockResolvedValue({ success: true, id: testId });
      });

      it("should create with all defaults when debugLevel is undefined", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection);

        expect(result).toBe(testId);
        expect(mockCreate).toHaveBeenCalledWith({
          DeveloperName: "Apex_Log_MCP_Debug_Level",
          MasterLabel: "Apex_Log_MCP_Debug_Level",
          ...allDefaults,
        });
      });

      it('should create with all defaults when debugLevel is "default"', async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, "default");

        expect(result).toBe(testId);
        expect(mockCreate).toHaveBeenCalledWith({
          DeveloperName: "Apex_Log_MCP_Debug_Level",
          MasterLabel: "Apex_Log_MCP_Debug_Level",
          ...allDefaults,
        });
      });

      it("should create with defaults merged with overrides", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, {
          apexCode: "FINEST",
          nba: "FINEST",
        });

        expect(result).toBe(testId);
        expect(mockCreate).toHaveBeenCalledWith({
          DeveloperName: "Apex_Log_MCP_Debug_Level",
          MasterLabel: "Apex_Log_MCP_Debug_Level",
          ...allDefaults,
          ApexCode: "FINEST",
          Nba: "FINEST",
        });
      });

      it("should create with all categories at specified level when debugLevel is a log level string", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, "FINEST");

        expect(result).toBe(testId);
        const createArg = mockCreate.mock.calls[0][0];
        expect(createArg.ApexCode).toBe("FINEST");
        expect(createArg.ApexProfiling).toBe("FINEST");
        expect(createArg.Callout).toBe("FINEST");
        expect(createArg.Database).toBe("FINEST");
        expect(createArg.Nba).toBe("FINEST");
        expect(createArg.System).toBe("FINEST");
        expect(createArg.Validation).toBe("FINEST");
        expect(createArg.Visualforce).toBe("FINEST");
        expect(createArg.Wave).toBe("FINEST");
        expect(createArg.Workflow).toBe("FINEST");
      });

      it("should create when existing record has null Id", async () => {
        mockQuery.mockResolvedValue({ records: [{ Id: null }] });

        const result = await getOrCreateDebugLevelId(mockConnection);

        expect(result).toBe(testId);
        expect(mockCreate).toHaveBeenCalled();
      });
    });

    describe("when debug level already exists", () => {
      beforeEach(() => {
        mockQuery.mockResolvedValue({ records: [{ Id: testId }] });
        mockUpdate.mockResolvedValue({ success: true });
      });

      it("should not update when debugLevel is undefined", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection);

        expect(result).toBe(testId);
        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
      });

      it('should update all categories to defaults when debugLevel is "default"', async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, "default");

        expect(result).toBe(testId);
        expect(mockUpdate).toHaveBeenCalledWith({
          Id: testId,
          ...allDefaults,
        });
      });

      it("should only update specified categories", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, {
          apexCode: "FINEST",
        });

        expect(result).toBe(testId);
        expect(mockUpdate).toHaveBeenCalledWith({
          Id: testId,
          ApexCode: "FINEST",
        });
      });

      it("should update all categories to specified level when debugLevel is a log level string", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, "FINEST");

        expect(result).toBe(testId);
        const updateArg = mockUpdate.mock.calls[0][0];
        expect(updateArg.ApexCode).toBe("FINEST");
        expect(updateArg.ApexProfiling).toBe("FINEST");
        expect(updateArg.Callout).toBe("FINEST");
        expect(updateArg.Database).toBe("FINEST");
        expect(updateArg.Nba).toBe("FINEST");
        expect(updateArg.System).toBe("FINEST");
        expect(updateArg.Validation).toBe("FINEST");
        expect(updateArg.Visualforce).toBe("FINEST");
        expect(updateArg.Wave).toBe("FINEST");
        expect(updateArg.Workflow).toBe("FINEST");
      });

      it("should update multiple specified categories", async () => {
        const result = await getOrCreateDebugLevelId(mockConnection, {
          apexCode: "FINEST",
          database: "NONE",
          nba: "FINE",
        });

        expect(result).toBe(testId);
        expect(mockUpdate).toHaveBeenCalledWith({
          Id: testId,
          ApexCode: "FINEST",
          Database: "NONE",
          Nba: "FINE",
        });
      });
    });

    describe("query behavior", () => {
      it("should query by DeveloperName with LIMIT 1", async () => {
        mockQuery.mockResolvedValue({ records: [{ Id: testId }] });
        mockUpdate.mockResolvedValue({ success: true });

        await getOrCreateDebugLevelId(mockConnection);

        const query = mockQuery.mock.calls[0][0] as string;
        expect(query).toContain(
          "WHERE DeveloperName = 'Apex_Log_MCP_Debug_Level'",
        );
        expect(query).toContain("LIMIT 1");
      });
    });

    describe("error handling", () => {
      it("should throw error when creation fails", async () => {
        mockQuery.mockResolvedValue({ records: [] });
        mockCreate.mockResolvedValue({
          success: false,
          errors: ["Creation failed"],
        });

        await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
          "Failed to create DebugLevel",
        );
      });

      it("should throw error when creation returns no ID", async () => {
        mockQuery.mockResolvedValue({ records: [] });
        mockCreate.mockResolvedValue({ success: true, id: null });

        await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
          "Failed to create DebugLevel",
        );
      });

      it("should throw error when update fails", async () => {
        mockQuery.mockResolvedValue({ records: [{ Id: testId }] });
        mockUpdate.mockResolvedValue({
          success: false,
          errors: ["Update failed"],
        });

        await expect(
          getOrCreateDebugLevelId(mockConnection, "default"),
        ).rejects.toThrow("Failed to update DebugLevel");
      });

      it("should propagate query errors", async () => {
        mockQuery.mockRejectedValue(new Error("Query failed"));

        await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
          "Query failed",
        );
      });

      it("should propagate creation errors", async () => {
        mockQuery.mockResolvedValue({ records: [] });
        mockCreate.mockRejectedValue(new Error("Creation failed"));

        await expect(getOrCreateDebugLevelId(mockConnection)).rejects.toThrow(
          "Creation failed",
        );
      });
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
      });
    });
  });
});

/** `apexCode` as a log header spells it: `APEX_CODE`. */
function toScreamingSnake(category: string): string {
  return category.replace(/([A-Z])/g, "_$1").toUpperCase();
}
