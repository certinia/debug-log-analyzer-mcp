/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";

import {
  clearApexLogCache,
  loadApexLog,
  logFilePathSchema,
  walkLog,
} from "../src/tools/apexLogSource";
import { parse, ApexLog, LogLine } from "../src/ApexLogParser";

jest.mock("fs", () => {
  const stat = jest.fn();
  const readFile = jest.fn();
  // A handle is the file at one path, so its stat and read delegate to the
  // mocks above with that path filled in. Tests set and assert on those.
  return {
    promises: {
      stat,
      readFile,
      open: jest.fn(async (path: string) => ({
        stat: (options: unknown) => stat(path, options),
        readFile: (encoding: unknown) => readFile(path, encoding),
        close: jest.fn(),
      })),
    },
  };
});

jest.mock("../src/ApexLogParser", () => ({
  parse: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockParse = parse as jest.MockedFunction<typeof parse>;

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

      expect(mockFs.open).toHaveBeenCalledWith(logPath, "r");
      expect(mockFs.readFile).toHaveBeenCalledWith(logPath, "utf-8");
      expect(mockParse).toHaveBeenCalledWith("log content");
      expect(log).toBe(mockParse.mock.results[0]?.value);
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

    it("parses again when a copy kept the modification time", async () => {
      await loadApexLog(logPath);
      // What `cp -p` leaves behind: same size, same mtime, same inode, and a
      // change time it cannot hold back.
      mockFs.stat.mockResolvedValue(statsOf(1, 10, { ctimeNs: 2 }));
      await loadApexLog(logPath);

      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("parses again when another file was renamed over the path", async () => {
      await loadApexLog(logPath);
      mockFs.stat.mockResolvedValue(statsOf(1, 10, { ino: 8 }));
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
      mockFs.stat.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      await expect(loadApexLog("/path/to/missing.log")).rejects.toThrow(
        "Log file not found: /path/to/missing.log",
      );
      expect(mockFs.readFile).not.toHaveBeenCalled();
    });
  });

  describe("logFilePathSchema", () => {
    it("accepts an absolute path", () => {
      expect(logFilePathSchema.safeParse("/logs/run.log").success).toBe(true);
    });

    it.each(["./run.log", ""])(
      "refuses %p rather than resolving it against our cwd",
      (path) => {
        const result = logFilePathSchema.safeParse(path);

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toBe(
          "must be an absolute path",
        );
      },
    );
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
