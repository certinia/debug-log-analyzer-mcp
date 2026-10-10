/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  promises as fs,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeDebugLog } from "../src/tools/logStore";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

// The real open, with `patch` applied to each handle it gives.
function patchOpenedHandles(patch: (handle: FileHandle, file: string) => void): void {
  const realOpen = fs.open.bind(fs);
  jest.spyOn(fs, "open").mockImplementation(async (file, flags) => {
    const handle = await realOpen(file, flags);
    patch(handle, file as string);
    return handle;
  });
}

describe("writeDebugLog", () => {
  let dir: string;

  // exFAT and some network shares have no hard links; the Apex has already run, so its log must still save.
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "log-store-"));
    jest
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("not permitted"), { code: "EPERM" }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should write the log under its id where the filesystem has no hard links", async () => {
    const filePath = await writeDebugLog(dir, "07L000000000001AAA", "log");

    expect(filePath).toBe(path.join(dir, "07L000000000001AAA.log"));
    expect(readFileSync(filePath, "utf8")).toBe("log");
    expect(readdirSync(dir)).toEqual(["07L000000000001AAA.log"]);
  });

  it("should leave no file under the id when the write fails", async () => {
    patchOpenedHandles((handle, file) => {
      // A disk that fills part way: some of the log lands, then the write fails.
      handle.writeFile = async () => {
        writeFileSync(file, "cut");
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      };
    });

    await expect(writeDebugLog(dir, "07L000000000001AAA", "log")).rejects.toThrow("no space");

    expect(readdirSync(dir)).toEqual([]);
  });

  // A share can report a failed write-back only at close.
  it("should leave no file under the id when closing it fails", async () => {
    patchOpenedHandles((handle) => {
      const realClose = handle.close.bind(handle);
      handle.close = async () => {
        await realClose();
        throw Object.assign(new Error("write-back failed"), { code: "EIO" });
      };
    });

    await expect(writeDebugLog(dir, "07L000000000001AAA", "log")).rejects.toThrow("write-back");

    expect(readdirSync(dir)).toEqual([]);
  });

  // The open failed, so the file there is not this call's to remove.
  it("should keep a log already there when opening the file fails", async () => {
    const filePath = path.join(dir, "07L000000000001AAA.log");
    writeFileSync(filePath, "earlier");
    jest
      .spyOn(fs, "open")
      .mockRejectedValue(Object.assign(new Error("too many open files"), { code: "EMFILE" }));

    await expect(writeDebugLog(dir, "07L000000000001AAA", "log")).rejects.toThrow("too many");

    expect(readFileSync(filePath, "utf8")).toBe("earlier");
  });

  it("should never write over a log already saved under the id", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    await writeDebugLog(dir, "07L000000000001AAA", "first");

    const filePath = await writeDebugLog(dir, "07L000000000001AAA", "second");

    expect(readFileSync(path.join(dir, "07L000000000001AAA.log"), "utf8")).toBe("first");
    expect(readFileSync(filePath, "utf8")).toBe("second");
  });
});
