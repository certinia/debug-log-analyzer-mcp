/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { saveErrorText } from "../src/salesforce/saveErrors";

describe("saveErrorText", () => {
  it.each([
    [[{ message: "bad value", fields: ["StartDate"] }, { message: "locked" }], "bad value (StartDate); locked"],
    [{ message: "locked" }, "locked"],
    ["locked", "locked"],
    [[{ statusCode: "X" }], '{"statusCode":"X"}'],
    [undefined, "the org gave no reason"],
  ])("reads %o as %s", (errors, text) => {
    expect(saveErrorText(errors)).toBe(text);
  });
});
