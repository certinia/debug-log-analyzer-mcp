/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { Connection } from "@salesforce/core";
import {
  downloadApexLog,
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
      ).rejects.toThrow(
        "cursor belongs to a list with other filters or another sortBy. Pass the same ones, or leave cursor out to start from the first page.",
      );
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
        "cursor is not one this tool returned",
      );
    });

    it.each([
      ["text that is not JSON", "not-a-cursor"],
      ["JSON that is not a list", Buffer.from("{}").toString("base64url")],
    ])("should refuse a cursor this tool did not return: %s", async (_name, cursor) => {
      await expect(list({ cursor })).rejects.toThrow(
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
