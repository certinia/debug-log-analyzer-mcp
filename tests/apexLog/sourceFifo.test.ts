/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { loadApexLog } from "../../src/apexLog";

// A real FIFO, since only the real open(2) blocks on one; source.test.ts mocks fs.
const onPosix = process.platform === "win32" ? describe.skip : describe;

onPosix("loadApexLog on a FIFO", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "apex-log-fifo-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses it instead of waiting for a writer", async () => {
    const fifo = path.join(dir, "pipe.log");
    execFileSync("mkfifo", [fifo]);

    await expect(loadApexLog(fifo)).rejects.toThrow(
      `Cannot read log file ${fifo}: not a regular file`,
    );
  }, 5_000);
});
