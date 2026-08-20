/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { toDateTimeLiteral } from "../../src/salesforce/soql";

describe("toDateTimeLiteral", () => {
  it("should stringify to a bare ISO 8601 literal", () => {
    const date = new Date("2026-08-20T09:15:30.500Z");

    // A `Date` here stringifies to "Thu Aug 20 2026 …", which SOQL rejects.
    expect(String(toDateTimeLiteral(date))).toBe("2026-08-20T09:15:30.500Z");
  });
});
