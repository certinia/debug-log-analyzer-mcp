/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { parse } from "@apexdevtools/apex-log-parser";
import { clearApexLogCache, loadApexLog } from "../../src/apexLog";

// Real files, since only the real open(2) blocks on a FIFO and only a real read gives bytes; source.test.ts mocks fs.
jest.mock("@apexdevtools/apex-log-parser", () => {
  const actual = jest.requireActual("@apexdevtools/apex-log-parser");
  return { ...actual, parse: jest.fn(actual.parse) };
});

const onPosix = process.platform === "win32" ? describe.skip : describe;

describe("loadApexLog on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "apex-log-disk-"));
    clearApexLogCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A string is a UTF-16 copy of the whole log beside the parse, twice the bytes of an ASCII log.
  it("gives the parser the file's bytes, not a decoded string", async () => {
    const file = path.join(dir, "test.log");
    const text = "64.0 APEX_CODE,FINE\n09:00:00.1 (2000)|USER_DEBUG|[1]|DEBUG|£100\n";
    writeFileSync(file, text);

    const log = await loadApexLog(file);

    expect(typeof jest.mocked(parse).mock.calls[0]?.[0]).not.toBe("string");
    expect(log.size).toBe(Buffer.byteLength(text, "utf8"));
  });

  onPosix("a FIFO", () => {
    it("is refused instead of waiting for a writer", async () => {
      const fifo = path.join(dir, "pipe.log");
      execFileSync("mkfifo", [fifo]);

      await expect(loadApexLog(fifo)).rejects.toThrow(
        `Cannot read log file ${fifo}: not a regular file`,
      );
    }, 5_000);
  });
});
