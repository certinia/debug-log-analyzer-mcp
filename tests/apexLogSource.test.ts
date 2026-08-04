/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type Stats } from "fs";

import {
  clearApexLogCache,
  isMethodNode,
  loadApexLog,
  walkLog,
} from "../src/tools/apexLogSource";
import { parse, ApexLog, LogLine } from "../src/ApexLogParser";

jest.mock("fs", () => ({
  promises: {
    stat: jest.fn(),
    readFile: jest.fn(),
  },
}));

jest.mock("../src/ApexLogParser", () => ({
  parse: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockParse = parse as jest.MockedFunction<typeof parse>;

const statsOf = (mtimeMs: number, size: number) => ({ mtimeMs, size }) as Stats;

const nodeOf = (props: Partial<LogLine>): LogLine => props as LogLine;

describe("apexLogSource", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearApexLogCache();
  });

  describe("loadApexLog", () => {
    const logPath = "/path/to/test.log";

    beforeEach(() => {
      mockFs.stat.mockResolvedValue(statsOf(1, 10));
      mockFs.readFile.mockResolvedValue("log content");
      mockParse.mockReturnValue({} as ApexLog);
    });

    it("parses the file on the first call", async () => {
      const log = await loadApexLog(logPath);

      expect(mockFs.readFile).toHaveBeenCalledWith(logPath, "utf-8");
      expect(mockParse).toHaveBeenCalledWith("log content");
      expect(log).toBe(mockParse.mock.results[0]?.value);
    });

    it("reuses the parse when the same unchanged file is asked for again", async () => {
      const first = await loadApexLog(logPath);
      const second = await loadApexLog(logPath);

      expect(second).toBe(first);
      expect(mockParse).toHaveBeenCalledTimes(1);
      expect(mockFs.readFile).toHaveBeenCalledTimes(1);
    });

    it("parses again when the file was modified", async () => {
      await loadApexLog(logPath);
      mockFs.stat.mockResolvedValue(statsOf(2, 10));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when the file size changed", async () => {
      await loadApexLog(logPath);
      mockFs.stat.mockResolvedValue(statsOf(1, 20));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when a different file is asked for", async () => {
      await loadApexLog(logPath);
      await loadApexLog("/path/to/other.log");

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("shares one parse between callers that arrive while it runs", async () => {
      let release: (content: string) => void = () => {};
      mockFs.readFile.mockReturnValue(
        new Promise<string>((resolve) => {
          release = resolve;
        }) as ReturnType<typeof fs.readFile>,
      );

      const both = Promise.all([loadApexLog(logPath), loadApexLog(logPath)]);
      release("log content");
      const [first, second] = await both;

      expect(second).toBe(first);
      expect(mockFs.readFile).toHaveBeenCalledTimes(1);
      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    it("does not serve a failed read to the next caller", async () => {
      mockFs.readFile.mockRejectedValueOnce(new Error("EACCES"));

      await expect(loadApexLog(logPath)).rejects.toThrow("EACCES");
      const retried = await loadApexLog(logPath);

      expect(retried).toBe(mockParse.mock.results[0]?.value);
      expect(mockFs.readFile).toHaveBeenCalledTimes(2);
    });

    it("reports a missing file and does not read it", async () => {
      mockFs.stat.mockRejectedValue(new Error("ENOENT"));

      await expect(loadApexLog("/path/to/missing.log")).rejects.toThrow(
        "Log file not found: /path/to/missing.log",
      );
      expect(mockFs.readFile).not.toHaveBeenCalled();
    });
  });

  describe("isMethodNode", () => {
    it("accepts code units, method entries and timed method nodes", () => {
      expect(isMethodNode(nodeOf({ type: "CODE_UNIT_STARTED" }))).toBe(true);
      expect(isMethodNode(nodeOf({ type: "METHOD_ENTRY" }))).toBe(true);
      expect(isMethodNode(nodeOf({ type: "SOQL_EXECUTE_BEGIN" }))).toBe(false);
      expect(
        isMethodNode({
          type: "CONSTRUCTOR_ENTRY",
          subCategory: "Method",
        } as unknown as LogLine),
      ).toBe(true);
    });
  });

  describe("walkLog", () => {
    it("visits the node and every node below it, parents first", () => {
      const tree = {
        type: "root",
        children: [{ type: "a", children: [{ type: "a1" }] }, { type: "b" }],
      } as unknown as LogLine;

      const seen: string[] = [];
      walkLog(tree, (node) => seen.push(node.type as string));

      expect(seen).toEqual(["root", "a", "a1", "b"]);
    });
  });
});
