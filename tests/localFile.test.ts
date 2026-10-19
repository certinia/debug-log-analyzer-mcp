/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { fileReadError } from "../src/tools/localFile";

describe("fileReadError", () => {
  it.each([
    ["EACCES", "permission denied (EACCES)"],
    ["EPERM", "permission denied (EPERM)"],
    ["EISDIR", "it is a directory (EISDIR)"],
    ["ELOOP", "too many symbolic links (ELOOP)"],
    ["EMFILE", "too many open files (EMFILE)"],
    ["ENFILE", "too many open files (ENFILE)"],
    ["EIO", "EIO"],
  ])("should name why %s stopped the read", (code, cause) => {
    expect(fileReadError("log file", "/a.log", { code }).message).toBe(
      `Cannot read log file /a.log: ${cause}`,
    );
  });

  it("should say a missing file is not found", () => {
    expect(fileReadError("Apex file", "/a.apex", { code: "ENOENT" }).message).toBe(
      "Apex file not found: /a.apex",
    );
  });
});
