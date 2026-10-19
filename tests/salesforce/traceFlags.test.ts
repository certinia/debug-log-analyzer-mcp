/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Connection } from "@salesforce/core";
import {
  createTraceFlag,
  destroyTraceFlags,
  findActiveTraceFlags,
  findOverlappingTraceFlag,
  MAX_DURATION_MINUTES,
  traceFlagWindow,
  listTraceFlags,
  resolveTracedEntity,
} from "../../src/salesforce/traceFlags";

describe("Trace Flags", () => {
  const tracedEntityId = "000000000000000000";
  const traceFlagId = "100000000000000000";
  const debugLevelId = "200000000000000000";
  const now = "2025-01-15T09:00:00.000Z";

  let mockConnection: jest.Mocked<Connection>;
  let mockSobject: jest.Mock;
  let mockCreate: jest.Mock;
  let mockDestroy: jest.Mock;
  let mockQuery: jest.Mock;
  let mockDataQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));

    mockCreate = jest.fn();
    mockDestroy = jest.fn();
    mockQuery = jest.fn();
    mockSobject = jest.fn().mockReturnValue({
      create: mockCreate,
      destroy: mockDestroy,
    });

    mockDataQuery = jest.fn();
    mockConnection = {
      tooling: { sobject: mockSobject, query: mockQuery },
      query: mockDataQuery,
    } as unknown as jest.Mocked<Connection>;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("findActiveTraceFlags", () => {
    const flagLevels = {
      ApexCode: "ERROR",
      ApexProfiling: "NONE",
      Callout: "NONE",
      Database: "INFO",
      Nba: "NONE",
      System: "WARN",
      Validation: "NONE",
      Visualforce: "NONE",
      Wave: "NONE",
      Workflow: "NONE",
    };

    it("gives the levels of each live flag, by log type", async () => {
      mockQuery.mockResolvedValue({
        records: [
          { LogType: "DEVELOPER_LOG", DebugLevel: { ...flagLevels, ApexCode: "FINEST" } },
          { LogType: "USER_DEBUG", DebugLevel: flagLevels },
        ],
      });

      const flags = await findActiveTraceFlags(mockConnection, tracedEntityId);

      expect(flags.storesLogs).toBe(true);
      expect(flags.userDebugLevels).toMatchObject({
        apexCode: "ERROR",
        database: "INFO",
        system: "WARN",
        workflow: "NONE",
      });
      expect(flags.developerConsoleLevels).toMatchObject({ apexCode: "FINEST" });
    });

    // A concurrent run's flag, or one a failed delete left, is the tool's, not the user's.
    it("stores logs but gives no levels for the tool's own run flag", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            LogType: "USER_DEBUG",
            DebugLevel: { ...flagLevels, DeveloperName: "Apex_Log_MCP_Debug_Level" },
          },
        ],
      });

      await expect(
        findActiveTraceFlags(mockConnection, tracedEntityId),
      ).resolves.toEqual({ storesLogs: true, userDebugLevels: undefined });
    });

    // Its levels beat the header, so they are the run's, but they are not the user's flag.
    it("stores logs and gives its own levels for a Developer Console flag alone", async () => {
      mockQuery.mockResolvedValue({
        records: [{ LogType: "DEVELOPER_LOG", DebugLevel: flagLevels }],
      });

      const flags = await findActiveTraceFlags(mockConnection, tracedEntityId);

      expect(flags.storesLogs).toBe(true);
      expect(flags.userDebugLevels).toBeUndefined();
      expect(flags.developerConsoleLevels).toMatchObject({ apexCode: "ERROR" });
    });

    it("stores nothing when the entity has no live flag", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await expect(
        findActiveTraceFlags(mockConnection, tracedEntityId),
      ).resolves.toEqual({ storesLogs: false, userDebugLevels: undefined });
    });

    // Live now, and of a type that stores the log, with the levels in the same query.
    it("asks for the entity's live USER_DEBUG and DEVELOPER_LOG flags and their levels", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await findActiveTraceFlags(mockConnection, tracedEntityId);

      const query = mockQuery.mock.calls[0]?.[0] as string;
      expect(query).toContain("FROM TraceFlag");
      expect(query).toContain(`TracedEntityId = '${tracedEntityId}'`);
      // A flag saved with no StartDate is live from the start.
      expect(query).toContain(`(StartDate = null OR StartDate <= ${now})`);
      expect(query).toContain(`ExpirationDate > ${now}`);
      expect(query).toContain("LogType IN ('USER_DEBUG', 'DEVELOPER_LOG')");
      Object.keys(flagLevels).forEach((field) =>
        expect(query).toContain(`DebugLevel.${field}`),
      );
    });

    it("passes a query error on", async () => {
      mockQuery.mockRejectedValue(new Error("Query failed"));

      await expect(
        findActiveTraceFlags(mockConnection, tracedEntityId),
      ).rejects.toThrow("Query failed");
    });
  });

  describe("createTraceFlag", () => {
    // Started back by the clock skew, so an org clock behind this one still sees it live.
    it("creates a USER_DEBUG flag from 5 minutes back until the duration ends", async () => {
      mockCreate.mockResolvedValue({ success: true, id: traceFlagId });

      await expect(
        createTraceFlag(mockConnection, tracedEntityId, debugLevelId, traceFlagWindow(900_000)),
      ).resolves.toBe(traceFlagId);

      expect(mockSobject).toHaveBeenCalledWith("TraceFlag");
      expect(mockCreate).toHaveBeenCalledWith({
        TracedEntityId: tracedEntityId,
        DebugLevelId: debugLevelId,
        StartDate: "2025-01-15T08:55:00.000Z",
        ExpirationDate: "2025-01-15T09:15:00.000Z",
        LogType: "USER_DEBUG",
      });
    });

    it("names the errors when Salesforce refuses the flag", async () => {
      mockCreate.mockResolvedValue({
        success: false,
        errors: ["Error 1", "Error 2"],
      });

      const created = createTraceFlag(
        mockConnection,
        tracedEntityId,
        debugLevelId,
        traceFlagWindow(900_000),
      );

      await expect(created).rejects.toThrow("Salesforce refused the trace flag");
      await expect(created).rejects.toThrow(/Error 1.*Error 2/);
    });

    it("passes a network error on", async () => {
      mockCreate.mockRejectedValue(new Error("Network error"));

      await expect(
        createTraceFlag(mockConnection, tracedEntityId, debugLevelId, traceFlagWindow(900_000)),
      ).rejects.toThrow("Network error");
    });
  });

  // Salesforce refuses a window of 24 hours or more from its StartDate.
  it("starts back less than the skew when the window would otherwise reach a day", () => {
    const { start, end } = traceFlagWindow(MAX_DURATION_MINUTES * 60_000);

    expect(end.getTime() - start.getTime()).toBeLessThan(24 * 60 * 60_000);
    expect(start.getTime()).toBeLessThan(Date.parse(now));
  });

  it("creates a CLASS_TRACING flag when asked", async () => {
    mockCreate.mockResolvedValue({ success: true, id: traceFlagId });

    await createTraceFlag(mockConnection, tracedEntityId, debugLevelId, traceFlagWindow(60_000), "CLASS_TRACING");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ LogType: "CLASS_TRACING" }),
    );
  });

  describe("traceFlagWindow", () => {
    it("starts no earlier than notBefore", () => {
      const notBefore = new Date("2025-01-15T08:58:00.000Z");

      expect(traceFlagWindow(900_000, notBefore).start).toEqual(notBefore);
    });
  });

  describe("resolveTracedEntity", () => {
    // A 15-character id, or a suffix in the wrong case, names the same record as the API's form.
    // Read as a name, it would be refused as one, telling the caller to pass the id it passed.
    it("refuses an id whose suffix does not match, as an id", async () => {
      await expect(
        resolveTracedEntity(mockConnection, "005000000000001AAB"),
      ).rejects.toThrow("005000000000001AAB is not a valid id");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("queries an id in its 18-character form", async () => {
      mockDataQuery.mockResolvedValue({
        records: [{ Id: "005000000000001AAA", Username: "me@example.com" }],
      });

      await resolveTracedEntity(mockConnection, "005000000000001");

      expect(mockDataQuery.mock.calls[0][0]).toContain("Id = '005000000000001AAA'");
    });

    // An inner class cannot be traced, and must not resolve to its outer class.
    it("finds nothing for a name of three parts, and queries nothing", async () => {
      await expect(
        resolveTracedEntity(mockConnection, "ns.Outer.Inner"),
      ).rejects.toThrow("is named ns.Outer.Inner");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("finds a user by username, and names them by it", async () => {
      mockDataQuery.mockResolvedValue({
        records: [{ Id: "005000000000001AAA", Username: "me@example.com" }],
      });

      await expect(resolveTracedEntity(mockConnection, "me@example.com")).resolves.toEqual({
        id: "005000000000001AAA",
        name: "me@example.com",
        type: "User",
      });
      expect(mockDataQuery).toHaveBeenCalledWith(
        "SELECT Id, Username FROM User WHERE Username = 'me@example.com'",
      );
    });

    it("finds a user by id", async () => {
      mockDataQuery.mockResolvedValue({
        records: [{ Id: "005000000000001AAA", Username: "me@example.com" }],
      });

      await resolveTracedEntity(mockConnection, "005000000000001AAA");

      expect(mockDataQuery.mock.calls[0][0]).toContain("WHERE Id = '005000000000001AAA'");
    });

    it("finds a namespaced class on its name and its namespace", async () => {
      mockQuery.mockImplementation(async (soql: string) => ({
        records: soql.includes("FROM ApexClass")
          ? [{ Id: "01p000000000001AAA", Name: "MyClass", NamespacePrefix: "ns" }]
          : [],
      }));

      await expect(
        resolveTracedEntity(mockConnection, "ns.MyClass"),
      ).resolves.toEqual({ id: "01p000000000001AAA", name: "ns.MyClass", type: "ApexClass" });
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE Name = 'MyClass' AND NamespacePrefix = 'ns'",
      );
    });

    // A local class has no namespace to name it by, so a bare name must reach it.
    it("takes a bare name for the org's own class over a package's", async () => {
      mockQuery.mockImplementation(async (soql: string) => ({
        records: soql.includes("FROM ApexClass")
          ? [
              { Id: "01p000000000001AAA", Name: "Utils", NamespacePrefix: "ns" },
              { Id: "01p000000000002AAA", Name: "Utils", NamespacePrefix: null },
            ]
          : [],
      }));

      await expect(resolveTracedEntity(mockConnection, "Utils")).resolves.toMatchObject({
        id: "01p000000000002AAA",
        name: "Utils",
      });
    });

    // A namespace cannot tell a class from a trigger, so the refusal lists the ids.
    it("refuses a name a class and a trigger both answer to, naming each by id", async () => {
      mockQuery.mockImplementation(async (soql: string) => ({
        records: [
          soql.includes("FROM ApexClass")
            ? { Id: "01p000000000001AAA", Name: "Account", NamespacePrefix: null }
            : { Id: "01q000000000001AAA", Name: "Account", NamespacePrefix: null },
        ],
      }));

      await expect(resolveTracedEntity(mockConnection, "Account")).rejects.toThrow(
        "More than one class or trigger is named Account: Account (ApexClass, 01p000000000001AAA), Account (ApexTrigger, 01q000000000001AAA). Pass its id as tracedEntity.",
      );
    });

    it("finds a trigger by its id", async () => {
      mockQuery.mockResolvedValue({
        records: [{ Id: "01q000000000001AAA", Name: "Account", NamespacePrefix: null }],
      });

      await expect(resolveTracedEntity(mockConnection, "01q000000000001AAA")).resolves.toEqual({
        id: "01q000000000001AAA",
        name: "Account",
        type: "ApexTrigger",
      });
    });

    it("says what it takes when nothing answers to the name", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await expect(resolveTracedEntity(mockConnection, "Nothing")).rejects.toThrow(
        "No user, class or trigger in this org is named Nothing",
      );
    });

    // A quote in a name would end the SOQL literal, and a backslash before it would undo its escape.
    it("escapes a quote and a backslash in a username", async () => {
      mockDataQuery.mockResolvedValue({ records: [] });

      await expect(resolveTracedEntity(mockConnection, "o\\'brien@example.com")).rejects.toThrow(
        "No user, class or trigger in this org has the username o\\'brien@example.com.",
      );
      expect(mockDataQuery.mock.calls[0][0]).toContain("'o\\\\\\'brien@example.com'");
    });
  });

  describe("listTraceFlags", () => {
    // A capped table must say it is capped, so the count comes beside it.
    it("returns at most 200 flags, with how many match in all", async () => {
      const page = Array.from({ length: 200 }, (_, index) => ({
        Id: `7tf${String(index).padStart(12, "0")}AAA`,
        TracedEntityId: "005000000000001AAA",
        LogType: "USER_DEBUG",
        DebugLevel: null,
        StartDate: null,
        CreatedDate: "2025-01-15T09:00:00.000+0000",
        ExpirationDate: "2025-01-15T09:30:00.000+0000",
      }));
      mockQuery.mockImplementation(async (soql: string) =>
        soql.startsWith("SELECT COUNT()") ? { totalSize: 250, records: [] } : { records: page },
      );
      mockDataQuery.mockResolvedValue({ records: [] });

      const { flags, matchedCount } = await listTraceFlags(mockConnection);

      expect(mockQuery.mock.calls[0][0]).toMatch(/ORDER BY ExpirationDate DESC\s+LIMIT 200$/);
      expect(mockQuery.mock.calls[1][0]).toMatch(
        /^SELECT COUNT\(\) FROM TraceFlag WHERE ExpirationDate > 2025-01-15T09:00:00.000Z$/,
      );
      expect(matchedCount).toBe(250);
      expect(flags).toHaveLength(200);
      // Every flag is on one user, so one lookup names them all.
      expect(mockDataQuery).toHaveBeenCalledTimes(1);
    });

    // Under the cap the rows are every match, so no count is asked for.
    it("counts the rows themselves when fewer than 200 come back", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await expect(listTraceFlags(mockConnection)).resolves.toEqual({ flags: [], matchedCount: 0 });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("names each entity as resolveTracedEntity takes it back, with its type", async () => {
      mockQuery.mockImplementation(async (soql: string) => ({
        records: soql.includes("FROM TraceFlag")
          ? [
              {
                Id: "7tf000000000001AAA",
                TracedEntityId: "005000000000001AAA",
                TracedEntity: { Name: "Jo Bloggs", Type: "User" },
                LogType: "USER_DEBUG",
                DebugLevel: { DeveloperName: "Mine", ApexCode: "FINEST" },
                StartDate: "2025-01-15T09:00:00.000+0000",
                ExpirationDate: "2025-01-15T09:30:00.000+0000",
              },
              {
                Id: "7tf000000000002AAA",
                TracedEntityId: "01p000000000001AAA",
                // The org sends a class's key prefix as its type.
                TracedEntity: { Name: "MyClass", Type: "01p" },
                LogType: "CLASS_TRACING",
                DebugLevel: { DeveloperName: "Mine" },
                // Set with no StartDate, so it started when it was created.
                StartDate: null,
                CreatedDate: "2025-01-15T08:50:00.000+0000",
                ExpirationDate: "2025-01-15T09:20:00.000+0000",
              },
            ]
          : [{ Id: "01p000000000001AAA", Name: "MyClass", NamespacePrefix: "ns" }],
      }));
      mockDataQuery.mockResolvedValue({
        records: [{ Id: "005000000000001AAA", Username: "jo@example.com" }],
      });

      const { flags } = await listTraceFlags(mockConnection);

      expect(flags.map((flag) => [flag.tracedEntity, flag.entityType])).toEqual([
        ["jo@example.com", "User"],
        ["ns.MyClass", "ApexClass"],
      ]);
      expect(flags[1]?.startTime).toBe("2025-01-15T08:50:00Z");
      expect(flags[0]).toMatchObject({
        debugLevelName: "Mine",
        startTime: "2025-01-15T09:00:00Z",
        expirationTime: "2025-01-15T09:30:00Z",
      });
      expect(flags[0]?.levels).toMatch(/^apexCode, database FINEST;/);
    });

    it("asks only for flags not yet expired, on the one entity when given", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await listTraceFlags(mockConnection, {
        id: "005000000000001AAA",
        name: "jo@example.com",
        type: "User",
      });

      expect(mockQuery.mock.calls[0][0]).toMatch(
        /WHERE ExpirationDate > 2025-01-15T09:00:00.000Z AND TracedEntityId = '005000000000001AAA'/,
      );
      // The entity is named already, so no lookup is made.
      expect(mockDataQuery).not.toHaveBeenCalled();
    });
  });

  describe("findOverlappingTraceFlag", () => {
    // A new flag starts back by the skew, so one that ended inside it still overlaps.
    it("asks for a flag of the same log type ending after the new one starts", async () => {
      mockQuery.mockResolvedValue({ records: [] });

      await findOverlappingTraceFlag(
        mockConnection,
        { id: "005000000000001AAA", name: "jo@example.com", type: "User" },
        "USER_DEBUG",
        900_000,
      );

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toMatch(
        /WHERE TracedEntityId = '005000000000001AAA' AND LogType = 'USER_DEBUG'\s+AND ExpirationDate > 2025-01-15T08:55:00.000Z/,
      );
      // A flag that starts after the new one ends does not overlap it.
      expect(query).toContain(
        "AND (StartDate = null OR StartDate < 2025-01-15T09:15:00.000Z)",
      );
    });
  });

  describe("findOverlappingTraceFlag's answer", () => {
    const jo = { id: "005000000000001AAA", name: "jo@example.com", type: "User" as const };
    const flagEnding = (ExpirationDate: string) => ({
      records: [
        {
          Id: "7tf000000000001AAA",
          TracedEntityId: jo.id,
          LogType: "USER_DEBUG",
          DebugLevel: null,
          StartDate: "2025-01-15T08:00:00.000+0000",
          ExpirationDate,
        },
      ],
    });

    it("returns a flag still live as blocking", async () => {
      mockQuery.mockResolvedValue(flagEnding("2025-01-15T09:10:00.000+0000"));

      const overlap = await findOverlappingTraceFlag(mockConnection, jo, "USER_DEBUG", 900_000);

      expect(overlap.live?.id).toBe("7tf000000000001AAA");
      expect(overlap.notBefore).toBeUndefined();
    });

    // It ended inside the clock skew: it logs no more, so it only moves the start.
    it("returns a second after a flag that has ended as the earliest start", async () => {
      mockQuery.mockResolvedValue(flagEnding("2025-01-15T08:58:00.000+0000"));

      await expect(
        findOverlappingTraceFlag(mockConnection, jo, "USER_DEBUG", 900_000),
      ).resolves.toEqual({ notBefore: new Date("2025-01-15T08:58:01.000Z") });
    });
  });

  describe("destroyTraceFlags", () => {
    // Deleted by another call, or expired, since it was found: what the org sends, checked on a real org.
    it("marks a flag already gone, and keeps another failure beside its id", async () => {
      mockDestroy.mockImplementation(async (id: string) => {
        if (id === "7tf000000000001AAA") {
          throw Object.assign(new Error("invalid cross reference id"), {
            errorCode: "INVALID_CROSS_REFERENCE_KEY",
          });
        }
        if (id === "7tf000000000002AAA") {
          throw new Error("insufficient access rights");
        }
        if (id === "7tf000000000004AAA") {
          return {
            success: false,
            errors: [{ statusCode: "ENTITY_IS_DELETED", message: "entity is deleted" }],
          };
        }
        return { success: true, id };
      });

      await expect(
        destroyTraceFlags(mockConnection, [
          "7tf000000000001AAA",
          "7tf000000000002AAA",
          "7tf000000000003AAA",
          "7tf000000000004AAA",
        ]),
      ).resolves.toEqual([
        { id: "7tf000000000001AAA", alreadyGone: true },
        { id: "7tf000000000002AAA", error: "insufficient access rights" },
        { id: "7tf000000000003AAA" },
        { id: "7tf000000000004AAA", alreadyGone: true },
      ]);
    });

    // A request left running could delete a flag under a retry sent right after the cancel.
    it("waits for the deletes in flight, sends no more, then rejects once cancelled", async () => {
      jest.useRealTimers();
      const controller = new AbortController();
      let settled = 0;
      // The fourth delete cancels and returns at once, while the first three still run.
      mockDestroy.mockImplementation(async (id: string) => {
        if (mockDestroy.mock.calls.length === 4) {
          controller.abort();
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        settled += 1;
        return { success: true, id };
      });
      const ids = Array.from({ length: 8 }, (_, index) => `7tf00000000000${index}AAA`);

      await expect(destroyTraceFlags(mockConnection, ids, controller.signal)).rejects.toThrow();
      expect(mockDestroy).toHaveBeenCalledTimes(4);
      expect(settled).toBe(4);
    });
  });
});
