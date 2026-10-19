/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { saveErrorText, thrownOutcome } from "../src/salesforce/deleteResults";

describe("thrownOutcome", () => {
  it("reads a gone errorCode beside a numeric statusCode", () => {
    const error = Object.assign(new Error("entity is deleted"), { statusCode: 404, errorCode: "ENTITY_IS_DELETED" });

    expect(thrownOutcome(error)).toEqual({ alreadyGone: true });
  });
});

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
