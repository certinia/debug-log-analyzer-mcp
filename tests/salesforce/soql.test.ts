/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { containing, quote, toDateTimeLiteral } from "../../src/salesforce/soql";

describe("toDateTimeLiteral", () => {
  it("should stringify to a bare ISO 8601 literal", () => {
    const date = new Date("2026-08-20T09:15:30.500Z");

    // A `Date` here stringifies to "Thu Aug 20 2026 …", which SOQL rejects.
    expect(String(toDateTimeLiteral(date))).toBe("2026-08-20T09:15:30.500Z");
  });
});

// No character in a value may end the literal it goes into.
describe("quote", () => {
  it("should escape every character SOQL reads as special, and leave the rest and LIKE wildcards", () => {
    expect(quote("a'b\\c\"d\ne\rf\tg\bh\fi%_\v")).toBe(
      "'a\\'b\\\\c\\\"d\\ne\\rf\\tg\\bh\\fi%_\v'",
    );
  });
});

describe("containing", () => {
  it("should match anywhere, escaping what quote does and its own % and _", () => {
    expect(containing("a'b\\c\"d\ne\rf\tg\bh\fi%_")).toBe(
      "'%a\\'b\\\\c\\\"d\\ne\\rf\\tg\\bh\\fi\\%\\_%'",
    );
  });
});
