/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";

import {
  clearApexLogCache,
  loadApexLog,
  walkLog,
} from "../../src/apexLog";
import { parse } from "@apexdevtools/apex-log-parser";
import type { ApexEvent, ApexLog } from "@apexdevtools/apex-log-parser";

// On the handle alone, so a stat or read of the path itself fails: the loader
// must read the file it fingerprinted. Each delegates with the handle's path.
const mockStat = jest.fn();
const mockReadFile = jest.fn();
jest.mock("fs", () => ({
  constants: jest.requireActual("fs").constants,
  promises: {
    open: jest.fn(async (path: string) => ({
      stat: (options: unknown) => mockStat(path, options),
      readFile: (options: unknown) => mockReadFile(path, options),
      close: jest.fn(),
    })),
  },
}));

jest.mock("@apexdevtools/apex-log-parser", () => ({
  ...jest.requireActual("@apexdevtools/apex-log-parser"),
  parse: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockParse = parse as jest.MockedFunction<typeof parse>;
const BYTES = Buffer.from("log content");

const statsOf = (
  mtimeNs: number,
  size: number,
  { ctimeNs = mtimeNs, ino = 7 } = {},
) =>
  ({
    ino: BigInt(ino),
    size: BigInt(size),
    mtimeNs: BigInt(mtimeNs),
    ctimeNs: BigInt(ctimeNs),
    isFile: () => true,
  }) as BigIntStats;

/**
 * Run the body with the clock under our control. `jest.useRealTimers()` leaves
 * `globalThis.clearTimeout` deleted rather than restored in this environment,
 * so the real ones are put back by hand.
 */
const withFakeTimers = async (body: () => Promise<void>): Promise<void> => {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  jest.useFakeTimers();
  try {
    await body();
  } finally {
    jest.useRealTimers();
    Object.assign(globalThis, real);
  }
};

describe("apexLog source", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearApexLogCache();
  });

  describe("loadApexLog", () => {
    const logPath = "/path/to/test.log";

    beforeEach(() => {
      mockStat.mockResolvedValue(statsOf(1, 10));
      mockReadFile.mockResolvedValue(BYTES);
      mockParse.mockImplementation(async () => ({}) as ApexLog);
    });

    it("closes every file it opens", async () => {
      await loadApexLog(logPath);
      // The second call is a cache hit, and still opened the file to stat it.
      await loadApexLog(logPath);

      const handles = await Promise.all(
        mockFs.open.mock.results.map((result) => result.value),
      );
      expect(handles).toHaveLength(2);
      handles.forEach((handle) => expect(handle.close).toHaveBeenCalled());
    });

    it("reuses the parse when the same unchanged file is asked for again", async () => {
      const first = await loadApexLog(logPath);
      const second = await loadApexLog(logPath);

      expect(second).toBe(first);
      expect(mockParse).toHaveBeenCalledTimes(1);
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it("parses again when the file was modified", async () => {
      await loadApexLog(logPath);
      mockStat.mockResolvedValue(statsOf(2, 10));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when the file size changed", async () => {
      await loadApexLog(logPath);
      mockStat.mockResolvedValue(statsOf(1, 20));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when a copy kept the modification time", async () => {
      await loadApexLog(logPath);
      // What `cp -p` leaves behind: same size, same mtime, same inode, and a
      // change time it cannot hold back.
      mockStat.mockResolvedValue(statsOf(1, 10, { ctimeNs: 2 }));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when another file was renamed over the path", async () => {
      await loadApexLog(logPath);
      mockStat.mockResolvedValue(statsOf(1, 10, { ino: 8 }));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when a different file is asked for", async () => {
      await loadApexLog(logPath);
      await loadApexLog("/path/to/other.log");

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("drops the parse once it has sat unused", async () => {
      await withFakeTimers(async () => {
        await loadApexLog(logPath);
        jest.advanceTimersByTime(5 * 60_000);
        await loadApexLog(logPath);
      });

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("keeps the parse while it is still asked for", async () => {
      await withFakeTimers(async () => {
        await loadApexLog(logPath);
        jest.advanceTimersByTime(4 * 60_000);
        await loadApexLog(logPath);
        jest.advanceTimersByTime(4 * 60_000);
        await loadApexLog(logPath);
      });

      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    it("shares one parse between callers that arrive while it runs", async () => {
      let release: (log: ApexLog) => void = () => {};
      mockParse.mockReturnValueOnce(
        new Promise<ApexLog>((resolve) => {
          release = resolve;
        }),
      );

      const both = Promise.all([loadApexLog(logPath), loadApexLog(logPath)]);
      release({} as ApexLog);
      const [first, second] = await both;

      expect(second).toBe(first);
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    // A directory opens on macOS and Linux; the read alone would fail, naming no path.
    it.each([
      [true, "it is a directory (EISDIR)"],
      [false, "not a regular file"],
    ])("refuses a path that is not a regular file, before reading it (directory: %s)", async (isDirectory, cause) => {
      mockStat.mockResolvedValueOnce({
        ...statsOf(1, 0),
        isFile: () => false,
        isDirectory: () => isDirectory,
      } as never);

      await expect(loadApexLog(logPath)).rejects.toThrow(
        `Cannot read log file ${logPath}: ${cause}`,
      );
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("hands a parse failure to the caller, and parses again next time", async () => {
      mockParse.mockRejectedValueOnce(new Error("Failed to parse log"));

      await expect(loadApexLog(logPath)).rejects.toThrow("Failed to parse log");
      const retried = await loadApexLog(logPath);

      expect(retried).toBe(await mockParse.mock.results[1]?.value);
      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("reports a missing file and does not read it", async () => {
      mockStat.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      await expect(loadApexLog("/path/to/missing.log")).rejects.toThrow(
        "Log file not found: /path/to/missing.log",
      );
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });

  describe("walkLog", () => {
    it("visits the node and every node below it, parents first", () => {
      const tree = {
        type: "root",
        children: [
          { type: "a", children: [{ type: "a1", children: [] }] },
          { type: "b", children: [] },
        ],
      } as unknown as ApexEvent;

      const seen: string[] = [];
      walkLog(tree, (node) => seen.push(node.type as string));

      expect(seen).toEqual(["root", "a", "a1", "b"]);
    });
  });
});
