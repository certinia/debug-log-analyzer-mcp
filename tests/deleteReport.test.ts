/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { thrownOutcome } from "../src/salesforce/deleteResults";
import { deleteReport, givenIds } from "../src/tools/deleteReport";

const LONG_1 = "7tf000000000001AAA";
const LONG_2 = "7tf000000000002AAA";
const LONG_3 = "7tf000000000003AAA";
const MISSING = "7tf000000000009AAA";

describe("deleteReport", () => {
  it("lists an id gone before the delete as not found, after the ids that named nothing, in the form sent", () => {
    const given = givenIds(["7tf000000000001", LONG_2, MISSING]);

    const report = deleteReport(given, [LONG_1, LONG_2], [{ id: LONG_1, alreadyGone: true }, { id: LONG_2 }], Infinity);

    expect(report.deleted).toEqual(new Set([LONG_2]));
    expect(report.notFoundIds).toEqual([MISSING, "7tf000000000001"]);
    expect(report.notFoundCount).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.failedCount).toBe(0);
  });

  it("counts every failed id, but lists at most idLimit of them", () => {
    const report = deleteReport(
      new Map(),
      [LONG_1, LONG_2, LONG_3],
      [LONG_1, LONG_2, LONG_3].map((id) => ({ id, error: "insufficient access rights" })),
      2,
    );

    expect(report.failed).toEqual([{ error: "insufficient access rights", idCount: 3, ids: [LONG_1, LONG_2] }]);
    expect(report.failedCount).toBe(3);
  });
});

describe("thrownOutcome", () => {
  it("reads a gone errorCode beside a numeric statusCode", () => {
    const error = Object.assign(new Error("entity is deleted"), { statusCode: 404, errorCode: "ENTITY_IS_DELETED" });

    expect(thrownOutcome(error)).toEqual({ alreadyGone: true });
  });
});
