/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { Connection } from "@salesforce/core";
import {
  deleteApexLogs,
  downloadApexLog,
  findApexLogs,
  isApexLogId,
  latestApexLogIds,
  listApexLogs,
  readCursor,
  type LogFilters,
  type LogSort,
} from "../../src/salesforce/apexLogs";
import { toLongId } from "../../src/salesforce/soql";

function record(id: string, overrides: Record<string, unknown> = {}) {
  return {
    Id: id,
    LogUser: { Username: "me@example.com" },
    Operation: "/aura",
    Request: "Application",
    Status: "Success",
    StartTime: "2026-10-09T09:29:31.000+0000",
    DurationMilliseconds: 38,
    LogLength: 1794,
    ...overrides,
  };
}

describe("apexLogs", () => {
  let query: jest.Mock;
  let request: jest.Mock;
  let destroy: jest.Mock;
  let connection: Connection;

  /** The page query, then the count, as `listApexLogs` sends them. */
  function answer(records: unknown[], totalSize = records.length) {
    query.mockImplementation(async (soql: string) =>
      soql.startsWith("SELECT COUNT()")
        ? { totalSize, records: [] }
        : { totalSize: records.length, records },
    );
  }

  const pageQuery = () =>
    query.mock.calls
      .map(([soql]) => soql as string)
      .find((soql) => !soql.startsWith("SELECT COUNT()"))!;
  const countQuery = () =>
    query.mock.calls
      .map(([soql]) => soql as string)
      .find((soql) => soql.startsWith("SELECT COUNT()"))!;

  const list = async (
    options: Partial<{
      filters: LogFilters;
      sortBy: LogSort;
      limit: number;
      cursor: string;
    }> = {},
  ) => {
    const { filters = {}, sortBy = "startTime", limit = 2, cursor } = options;
    // As the tool does: the cursor is read, then the page is fetched after it.
    return listApexLogs(connection, {
      filters,
      sortBy,
      limit,
      after: cursor === undefined ? undefined : readCursor(cursor, sortBy, filters),
    });
  };

  beforeEach(() => {
    query = jest.fn();
    request = jest.fn();
    destroy = jest.fn();
    connection = {
      query,
      request,
      sobject: () => ({ destroy }),
      getApiVersion: () => "67.0",
    } as unknown as Connection;
  });

  describe("listApexLogs", () => {
    it("should sort, tie-break on Id and fetch one past the limit, in SOQL", async () => {
      answer([]);

      await list({ limit: 20 });

      expect(pageQuery()).toMatch(
        /FROM ApexLog ORDER BY StartTime DESC, Id DESC LIMIT 21$/,
      );
      expect(countQuery()).toBe("SELECT COUNT() FROM ApexLog");
    });

    it.each([
      ["durationTotalMs", "DurationMilliseconds"],
      ["fileSizeBytes", "LogLength"],
    ] as const)("should sort %s on %s", async (sortBy, field) => {
      answer([]);

      await list({ sortBy });

      expect(pageQuery()).toContain(`ORDER BY ${field} DESC, Id DESC`);
    });

    it("should put every filter in the WHERE of both queries", async () => {
      answer([]);

      await list({
        filters: {
          user: "me@example.com",
          operation: "aura",
          request: "Application",
          succeeded: false,
          startTimeFrom: "2026-10-09T09:00:00+01:00",
          startTimeTo: "2026-10-09T10:00:00Z",
          minFileSizeBytes: 1000,
        },
      });

      const where =
        "WHERE LogUser.Username = 'me@example.com' AND Operation LIKE '%aura%' AND Request = 'Application' AND Status != 'Success' AND StartTime >= 2026-10-09T08:00:00.000Z AND StartTime <= 2026-10-09T10:00:00.000Z AND LogLength >= 1000";
      expect(pageQuery()).toContain(where);
      expect(countQuery()).toBe(`SELECT COUNT() FROM ApexLog ${where}`);
    });

    // The same rule the delete guard reads, so an empty value can never pass for a filter there.
    it("should take an empty string or a zero for no filter", async () => {
      answer([]);

      await list({ filters: { user: "", operation: "", minFileSizeBytes: 0 } });

      expect(countQuery()).toBe("SELECT COUNT() FROM ApexLog");
    });

    // A quote or newline would end the literal; a % or _ would match more than was asked.
    it("should escape quotes, backslashes, control characters and LIKE wildcards", async () => {
      answer([]);

      await list({
        filters: {
          user: "o'brien\\x@example.com",
          operation: "50%_off'",
          request: 'a\nb"c',
        },
      });

      expect(pageQuery()).toContain(
        "LogUser.Username = 'o\\'brien\\\\x@example.com'",
      );
      expect(pageQuery()).toContain("Operation LIKE '%50\\%\\_off\\'%'");
      expect(pageQuery()).toContain("Request = 'a\\nb\\\"c'");
    });

    it("should return rows with ISO start times and the count of every match", async () => {
      answer([record("07L000000000001EAA")], 39);

      const page = await list();

      expect(page).toEqual({
        rows: [
          {
            id: "07L000000000001EAA",
            user: "me@example.com",
            operation: "/aura",
            request: "Application",
            succeeded: true,
            exceptionMessage: "",
            startTime: "2026-10-09T09:29:31Z",
            durationTotalMs: 38,
            fileSizeBytes: 1794,
          },
        ],
        matchedCount: 39,
      });
    });

    it("should give a failed log's status as its exception message", async () => {
      answer([record("07L000000000001EAA", { Status: "System.LimitException: Too many SOQL queries: 101" })]);

      const page = await list();

      expect(page.rows[0]).toMatchObject({
        succeeded: false,
        exceptionMessage: "System.LimitException: Too many SOQL queries: 101",
      });
    });

    it("should give no cursor on the last page", async () => {
      answer([record("07L000000000002EAA"), record("07L000000000001EAA")]);

      const page = await list({ limit: 2 });

      expect(page.rows).toHaveLength(2);
      expect(page.nextCursor).toBeUndefined();
    });

    // Past SOQL's 2,000-row OFFSET: the next page starts after the last row's sort value, Id breaking a tie.
    it("should page on from the last row, by its sort value and Id", async () => {
      answer([
        record("07L000000000003EAA", { DurationMilliseconds: 90 }),
        record("07L000000000002EAA", { DurationMilliseconds: 50 }),
        record("07L000000000001EAA", { DurationMilliseconds: 50 }),
      ]);
      const first = await list({
        sortBy: "durationTotalMs",
        filters: { succeeded: true },
      });
      expect(first.rows).toHaveLength(2);
      query.mockClear();
      answer([]);

      await list({
        sortBy: "durationTotalMs",
        filters: { succeeded: true },
        cursor: first.nextCursor!,
      });

      expect(pageQuery()).toContain(
        "WHERE Status = 'Success' AND (DurationMilliseconds < 50 OR (DurationMilliseconds = 50 AND Id < '07L000000000002EAA'))",
      );
    });

    // The count is of every match, not of what is left, so the first page's count is carried on.
    it("should count on the first page only", async () => {
      answer([record("07L000000000002EAA"), record("07L000000000001EAA")], 39);
      const first = await list({ limit: 1 });
      query.mockClear();
      answer([record("07L000000000001EAA")], 7);

      const next = await list({ limit: 1, cursor: first.nextCursor! });

      expect(countQuery()).toBeUndefined();
      expect(next.matchedCount).toBe(39);
    });

    it("should page on a start time as a literal SOQL reads", async () => {
      answer([record("07L000000000002EAA"), record("07L000000000001EAA")]);
      const first = await list({ limit: 1 });
      query.mockClear();
      answer([]);

      await list({ limit: 1, cursor: first.nextCursor! });

      expect(pageQuery()).toContain(
        "(StartTime < 2026-10-09T09:29:31.000Z OR (StartTime = 2026-10-09T09:29:31.000Z AND Id < '07L000000000002EAA'))",
      );
    });

    it.each([
      ["another sortBy", { sortBy: "fileSizeBytes" as const }],
      ["other filters", { filters: { succeeded: false } }],
    ])("should refuse a cursor reused with %s", async (_name, change) => {
      answer([record("07L000000000002EAA"), record("07L000000000001EAA")]);
      const first = await list({ limit: 1 });

      await expect(
        list({ limit: 1, cursor: first.nextCursor!, ...change }),
      ).rejects.toThrow("cursor belongs to a list with other filters");
    });

    // The value is written into SOQL, so it must be the sort's own type.
    it.each([
      ["startTime", "1 OR Id != null"],
      ["durationTotalMs", "50) OR (Id != null"],
    ] as const)("should refuse a %s cursor whose value is not its type", async (sortBy, value) => {
      answer([record("07L000000000002EAA"), record("07L000000000001EAA")]);
      const genuine = (await list({ limit: 1, sortBy })).nextCursor!;
      const [key, , id, count] = JSON.parse(
        Buffer.from(genuine, "base64url").toString(),
      );
      const forged = Buffer.from(JSON.stringify([key, value, id, count])).toString(
        "base64url",
      );

      expect(() => readCursor(forged, sortBy, {})).toThrow(
        "cursor belongs to a list with other filters",
      );
    });

    it("should refuse a cursor this tool did not return", async () => {
      await expect(list({ cursor: "not-a-cursor" })).rejects.toThrow(
        "cursor is not one this tool returned",
      );
    });
  });

  // Pairs from psa, where the API returned the 18-character form.
  // A suffix that is not the one its first 15 give is a mistyped id, refused rather than corrected.
  it.each([
    ["07LRL00000QFiGK2A1", true],
    ["07LRL00000QFiGK2a1", true],
    ["07LRL00000QFiGK", true],
    ["07LRL00000QFiGKZZZ", false],
  ])("should take %s as a log id: %s", (id, valid) => {
    expect(isApexLogId(id)).toBe(valid);
  });

  it.each([
    ["07LRL00000QFiGK", "07LRL00000QFiGK2A1"],
    ["07LRL00000QG20T", "07LRL00000QG20T2AT"],
    ["07LRL00000QG20T2AT", "07LRL00000QG20T2AT"],
    // The suffix ignores case, so it is rebuilt rather than trusted.
    ["07LRL00000QG20T2at", "07LRL00000QG20T2AT"],
  ])("should give %s in its 18-character form", (id, longId) => {
    expect(toLongId(id)).toBe(longId);
  });

  describe("findApexLogs", () => {
    it("should read every log the filters match, oldest first, with sizes and the full count", async () => {
      query.mockResolvedValue({
        totalSize: 10_001,
        records: [{ Id: "07L000000000001EAA", LogLength: 100 }],
      });

      await expect(
        findApexLogs(connection, { filters: { succeeded: false } }),
      ).resolves.toEqual({
        logs: [{ id: "07L000000000001EAA", fileSizeBytes: 100 }],
        matchedCount: 10_001,
      });
      expect(query).toHaveBeenCalledWith(
        "SELECT Id, LogLength FROM ApexLog WHERE Status != 'Success' ORDER BY StartTime, Id",
        { autoFetch: true, maxFetch: 10_000 },
      );
    });

    it("should read ids as quoted literals", async () => {
      query.mockResolvedValue({ totalSize: 0, records: [] });

      await findApexLogs(connection, {
        ids: ["07L000000000001EAA", "07L000000000002EAA"],
      });

      expect(query.mock.calls[0][0]).toContain(
        "WHERE Id IN ('07L000000000001EAA', '07L000000000002EAA')",
      );
    });
  });

  describe("deleteApexLogs", () => {
    // One past a batch, so a second request is needed.
    const ids = Array.from(
      { length: 201 },
      (_, index) => `07L${String(index).padStart(15, "0")}`,
    );
    // More batches than run at once, so some wait for a free slot.
    const many = Array.from({ length: 1000 }, (_, index) => `07L${index}`);

    it("should delete in batches of 200 and match each result to its id by position", async () => {
      destroy.mockImplementation(async (batch: string[]) =>
        batch.map((_, index) =>
          index === 1
            ? { success: false, errors: [{ message: "insufficient access rights" }] }
            : { success: true, errors: [] },
        ),
      );

      const sizes: number[] = [];

      const results = await deleteApexLogs(connection, ids, {
        onBatchDone: (count) => sizes.push(count),
      });

      expect(destroy.mock.calls.map(([batch]) => batch.length)).toEqual([200, 1]);
      expect(sizes.sort()).toEqual([1, 200]);
      expect(destroy).toHaveBeenCalledWith(expect.any(Array), { allOrNone: false });
      expect(results).toHaveLength(201);
      expect(results[1]).toEqual({ id: ids[1], error: "insufficient access rights" });
      expect(results[200]).toEqual({ id: ids[200] });
    });

    // The SDK sends no response to a cancelled call, so stopping the work is all that is left.
    it("should send no batch once the call is cancelled", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        deleteApexLogs(connection, ids, { signal: controller.signal }),
      ).rejects.toThrow();
      expect(destroy).not.toHaveBeenCalled();
    });

    // A permission or limit failure would fail every batch, so the rest are not sent.
    it("should send no batch after a request fails, and count every batch as done", async () => {
      destroy.mockRejectedValue(new Error("REQUEST_LIMIT_EXCEEDED"));
      let done = 0;

      const results = await deleteApexLogs(connection, many, {
        onBatchDone: (count) => (done += count),
      });

      expect(done).toBe(1000);
      // The first four were already in flight.
      expect(destroy).toHaveBeenCalledTimes(4);
      expect(results[999]).toEqual({
        id: many[999],
        error: "not sent, after an earlier request failed: REQUEST_LIMIT_EXCEEDED",
      });
    });

    it("should send no batch after the call is cancelled mid-run", async () => {
      const controller = new AbortController();
      destroy.mockImplementation(async (batch: string[]) => {
        controller.abort();
        return batch.map(() => ({ success: true, errors: [] }));
      });

      await expect(
        deleteApexLogs(connection, many, { signal: controller.signal }),
      ).rejects.toThrow();
      // The first request cancels before the next worker starts.
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    // A request left running could delete logs under a retry sent right after the cancel.
    it("should wait for the requests in flight before rejecting a cancelled call", async () => {
      const controller = new AbortController();
      let settled = 0;
      destroy.mockImplementation(async (batch: string[]) => {
        // Once all four slots hold a request.
        if (destroy.mock.calls.length === 4) {
          controller.abort();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled += 1;
        return batch.map(() => ({ success: true, errors: [] }));
      });

      await expect(
        deleteApexLogs(connection, many, { signal: controller.signal }),
      ).rejects.toThrow();
      expect(destroy).toHaveBeenCalledTimes(4);
      expect(settled).toBe(4);
    });

    it("should reject when the call is cancelled while its last batches run", async () => {
      const controller = new AbortController();
      destroy.mockImplementation(async (batch: string[]) => {
        controller.abort();
        return batch.map(() => ({ success: true, errors: [] }));
      });

      await expect(
        deleteApexLogs(connection, [ids[0]!], { signal: controller.signal }),
      ).rejects.toThrow();
    });

    // Another call, or the org's own expiry, can delete a log after it was found.
    it.each([
      [
        "mark a log already gone",
        [{ statusCode: "INVALID_CROSS_REFERENCE_KEY", message: "invalid cross reference id" }],
        { alreadyGone: true },
      ],
      [
        "mark a log already gone, as the per-record path names its code",
        [{ errorCode: "ENTITY_IS_DELETED", message: "entity is deleted" }],
        { alreadyGone: true },
      ],
      [
        "keep a failure with a log gone and another error",
        [
          { statusCode: "INVALID_CROSS_REFERENCE_KEY", message: "invalid cross reference id" },
          { statusCode: "INSUFFICIENT_ACCESS", message: "insufficient access" },
        ],
        { error: "invalid cross reference id; insufficient access" },
      ],
      ["keep a failure with no error at all", [], { error: "the org gave no reason" }],
    ])("should %s", async (_name, errors, outcome) => {
      destroy.mockResolvedValue([{ success: false, errors }]);

      await expect(deleteApexLogs(connection, [ids[0]!])).resolves.toEqual([
        { id: ids[0], ...outcome },
      ]);
    });

    // Logs already deleted by other batches are gone for good, so their report must survive.
    it("should keep a failed request to its own batch", async () => {
      destroy.mockImplementation(async (batch: string[]) => {
        if (batch.length === 1) {
          throw new Error("REQUEST_LIMIT_EXCEEDED");
        }
        return batch.map(() => ({ success: true, errors: [] }));
      });

      const results = await deleteApexLogs(connection, ids);

      expect(results.filter((result) => result.error === undefined)).toHaveLength(200);
      expect(results[200]).toEqual({ id: ids[200], error: "REQUEST_LIMIT_EXCEEDED" });
    });
  });

  it("should ask for the newest logs first", async () => {
    query.mockResolvedValue({ records: [{ Id: "07L000000000002EAA" }] });

    await expect(latestApexLogIds(connection, 3)).resolves.toEqual([
      "07L000000000002EAA",
    ]);
    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM ApexLog ORDER BY StartTime DESC, Id DESC LIMIT 3",
    );
  });

  it("should download a log's body", async () => {
    request.mockResolvedValue("67.0 APEX_CODE,FINE");

    await expect(
      downloadApexLog(connection, "07L000000000001EAA"),
    ).resolves.toBe("67.0 APEX_CODE,FINE");
    expect(request).toHaveBeenCalledWith(
      "/services/data/v67.0/sobjects/ApexLog/07L000000000001EAA/Body",
    );
  });
});
