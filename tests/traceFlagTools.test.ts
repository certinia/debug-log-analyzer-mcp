/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("../src/salesforce/connection", () => ({
  readLocalOrg: jest.fn(),
  connectOrg: jest.fn(),
}));

jest.mock("../src/salesforce/orgClassification", () => ({
  ...jest.requireActual("../src/salesforce/orgClassification"),
  classifyOrg: jest.fn(),
}));

jest.mock("../src/salesforce/traceFlags", () => ({
  ...jest.requireActual("../src/salesforce/traceFlags"),
  createTraceFlag: jest.fn(),
  destroyTraceFlags: jest.fn(),
  findOverlappingTraceFlag: jest.fn(),
  findTraceFlags: jest.fn(),
  listTraceFlags: jest.fn(),
  resolveTracedEntity: jest.fn(),
}));

jest.mock("../src/salesforce/debugLevels", () => ({
  ...jest.requireActual("../src/salesforce/debugLevels"),
  ensureLevelsDebugLevel: jest.fn(),
}));

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { AuthInfo, Org } from "@salesforce/core";
import { decode } from "@toon-format/toon";
import { listTraceFlags } from "../src/tools/listTraceFlags";
import { createTraceFlag } from "../src/tools/createTraceFlag";
import { deleteTraceFlags } from "../src/tools/deleteTraceFlags";
import { connectOrg, readLocalOrg, type LocalOrg } from "../src/salesforce/connection";
import { classifyOrg } from "../src/salesforce/orgClassification";
import * as flags from "../src/salesforce/traceFlags";
import {
  ensureLevelsDebugLevel,
  levelsClause,
  requestedLevels,
} from "../src/salesforce/debugLevels";
import { compileDenyList } from "../src/policy/orgDenyList";
import { createConfirmationLedger } from "../src/policy/orgExecutionPolicy";
import type { OrgAccessPolicy } from "../src/salesforce/orgAccess";

const mockReadLocalOrg = readLocalOrg as jest.MockedFunction<typeof readLocalOrg>;
const mockConnectOrg = connectOrg as jest.MockedFunction<typeof connectOrg>;
const mockClassifyOrg = classifyOrg as jest.MockedFunction<typeof classifyOrg>;
const mockList = flags.listTraceFlags as jest.MockedFunction<typeof flags.listTraceFlags>;
const mockFind = flags.findTraceFlags as jest.MockedFunction<typeof flags.findTraceFlags>;
const mockOverlap = flags.findOverlappingTraceFlag as jest.MockedFunction<typeof flags.findOverlappingTraceFlag>;
const mockResolve = flags.resolveTracedEntity as jest.MockedFunction<typeof flags.resolveTracedEntity>;
const mockCreate = flags.createTraceFlag as jest.MockedFunction<typeof flags.createTraceFlag>;
const mockDestroy = flags.destroyTraceFlags as jest.MockedFunction<typeof flags.destroyTraceFlags>;
const mockEnsureLevel = ensureLevelsDebugLevel as jest.MockedFunction<typeof ensureLevelsDebugLevel>;

const LOCAL_ORG: LocalOrg = {
  orgId: "00D000000000001",
  username: "me@example.com",
  aliases: ["psa"],
  authInfo: {} as AuthInfo,
};
const connection = { tag: "connection" };
const USER = { id: "005000000000001AAA", name: "jo@example.com", type: "User" as const };
const FLAG = {
  id: "7tf000000000001AAA",
  tracedEntity: "jo@example.com",
  entityType: "User",
  logType: "USER_DEBUG",
  debugLevelName: "Apex_Log_MCP_abc",
  levels: "apexCode FINEST",
  startTime: "2026-10-09T09:00:00Z",
  expirationTime: "2026-10-09T09:30:00Z",
};

function server(): McpServer {
  return {
    server: {
      listRoots: jest.fn().mockResolvedValue({ roots: [{ uri: "file:///project" }] }),
    },
  } as unknown as McpServer;
}

const ctx = {
  mcpReq: { signal: new AbortController().signal, requestState: () => undefined },
} as unknown as ServerContext;

function policy(overrides: Partial<OrgAccessPolicy> = {}): OrgAccessPolicy {
  return {
    allowProductionOrgs: false,
    denyList: compileDenyList([]),
    classificationCache: new Map(),
    mintConfirmationState: jest.fn(),
    consumeConfirmation: createConfirmationLedger(),
    ...overrides,
  };
}

const text = (result: unknown) =>
  (result as { content: { text: string }[] }).content[0]!.text;

beforeEach(() => {
  jest.clearAllMocks();
  mockReadLocalOrg.mockResolvedValue(LOCAL_ORG);
  mockConnectOrg.mockResolvedValue({ getConnection: () => connection } as unknown as Org);
  mockClassifyOrg.mockResolvedValue({ classification: "scratch" });
  mockResolve.mockResolvedValue(USER);
});

describe("listTraceFlags", () => {
  it("should list one entity's flags, naming the entity beside an empty table", async () => {
    mockList.mockResolvedValue({ flags: [], matchedCount: 0 });

    const result = await listTraceFlags(server(), { tracedEntity: "jo@example.com" }, ctx, policy());

    expect(mockList).toHaveBeenCalledWith(connection, USER);
    expect(decode(text(result))).toEqual({
      org: "me@example.com (psa)",
      tracedEntity: "jo@example.com",
      matchedCount: 0,
      flags: [],
    });
  });

  it("should list every flag without asking, on production too", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockList.mockResolvedValue({ flags: [FLAG], matchedCount: 1 });

    const result = await listTraceFlags(server(), {}, ctx, policy());

    expect(mockList).toHaveBeenCalledWith(connection, undefined);
    expect(decode(text(result))).toMatchObject({ flags: [FLAG] });
  });
});

describe("createTraceFlag", () => {
  beforeEach(() => {
    mockEnsureLevel.mockResolvedValue({ id: "7dl000000000001AAA", name: "Apex_Log_MCP_abc" });
    mockCreate.mockResolvedValue(FLAG.id);
    mockOverlap.mockResolvedValue({});
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T09:05:00.250Z"));
  });

  afterEach(() => jest.restoreAllMocks());

  it("should create a flag at the levels asked for, for the minutes asked, and report it", async () => {
    const result = await createTraceFlag(
      server(),
      { tracedEntity: "jo@example.com", debugLevel: { apexCode: "FINEST" }, durationMinutes: 10 },
      ctx,
      policy(),
    );

    expect(mockEnsureLevel).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ apexCode: "FINEST", database: "FINEST", callout: "DEBUG" }),
    );
    expect(mockCreate).toHaveBeenCalledWith(
      connection,
      USER.id,
      "7dl000000000001AAA",
      expect.anything(),
      "USER_DEBUG",
    );
    expect(mockOverlap).toHaveBeenCalledWith(connection, USER, "USER_DEBUG", 600_000);
    // Times to the second, from 5 minutes back for the clock skew.
    expect(decode(text(result))).toEqual({
      org: "me@example.com (psa)",
      ...FLAG,
      levels: levelsClause(requestedLevels({ apexCode: "FINEST" })),
      startTime: "2026-10-09T09:00:00Z",
      expirationTime: "2026-10-09T09:15:00Z",
    });
  });

  it("should trace a class as CLASS_TRACING", async () => {
    mockResolve.mockResolvedValue({ id: "01p000000000001AAA", name: "ns.MyClass", type: "ApexClass" });

    await createTraceFlag(server(), { tracedEntity: "ns.MyClass" }, ctx, policy());

    expect(mockCreate).toHaveBeenCalledWith(connection, "01p000000000001AAA", expect.any(String), expect.anything(), "CLASS_TRACING");
  });

  // Never changes someone's flag (#207); returns it, to delete first.
  it("should refuse an entity that already has a flag of its type, naming it, and write nothing or ask", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockOverlap.mockResolvedValue({ live: FLAG });
    const mint = jest.fn();

    const result = await createTraceFlag(server(), { tracedEntity: "jo@example.com" }, ctx, policy({ mintConfirmationState: mint }));

    expect(text(result)).toContain("already has a USER_DEBUG trace flag, 7tf000000000001AAA");
    // A flag set for later reads as logging now without its start.
    expect(text(result)).toContain(`from ${FLAG.startTime} until ${FLAG.expirationTime}`);
    expect(text(result)).toContain("apexlog_delete_trace_flags");
    expect(mint).not.toHaveBeenCalled();
    expect(mockEnsureLevel).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("should start no earlier than the overlap check says", async () => {
    mockOverlap.mockResolvedValue({ notBefore: new Date("2026-10-09T09:03:01Z") });

    const result = await createTraceFlag(server(), { tracedEntity: "jo@example.com" }, ctx, policy());

    expect(decode(text(result))).toMatchObject({ startTime: "2026-10-09T09:03:01Z" });
  });

  // A class flag only sets levels, so the prompt must not promise logs.
  it("should tell production a class flag stores no log itself", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockResolve.mockResolvedValue({ id: "01p000000000001AAA", name: "ns.MyClass", type: "ApexClass" });

    const result = await createTraceFlag(server(), { tracedEntity: "ns.MyClass" }, ctx, policy());

    expect(JSON.stringify(result)).toContain("stores no log itself");
  });

  it("should ask production first, naming the entity, levels and minutes, and write nothing yet", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });

    const result = await createTraceFlag(server(), { tracedEntity: "jo@example.com", debugLevel: "FINEST" }, ctx, policy());

    const shown = JSON.stringify(result);
    expect(shown).toContain("Trace jo@example.com (User) as USER_DEBUG for 30 minutes");
    expect(shown).toContain("FINEST");
    expect(shown).toContain("can fill the org's log storage");
    expect(mockEnsureLevel).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("should name apexlog_delete_org_logs when the org's log storage is full", async () => {
    mockCreate.mockRejectedValue(new Error("Debug log storage limit exceeded"));

    const result = await createTraceFlag(server(), { tracedEntity: "jo@example.com" }, ctx, policy());

    expect(text(result)).toContain("apexlog_delete_org_logs");
  });

  // A flag set while the call waited for a confirmation was not there to name.
  it("should name the tools to clear a flag Salesforce found in the way", async () => {
    mockCreate.mockRejectedValue(
      new Error("FIELD_INTEGRITY_EXCEPTION: This entity is already being traced."),
    );

    const result = await createTraceFlag(server(), { tracedEntity: "jo@example.com" }, ctx, policy());

    expect(text(result)).toContain("apexlog_list_trace_flags");
    expect(text(result)).toContain("apexlog_delete_trace_flags");
  });

  it("should refuse a denied org before connecting", async () => {
    const result = await createTraceFlag(
      server(),
      { tracedEntity: "jo@example.com" },
      ctx,
      policy({ denyList: compileDenyList(["psa"]) }),
    );

    expect(text(result)).toContain("Cannot create a trace flag against org");
    expect(mockConnectOrg).not.toHaveBeenCalled();
  });
});

describe("deleteTraceFlags", () => {
  const FOUND = [{ ...FLAG, tracedEntity: "Jo" }];

  // Not a failure: a retry after a lost response finds the flags it deleted gone.
  it("should delete the flags found and list an unknown id apart, as sent", async () => {
    mockFind.mockResolvedValue(FOUND);
    mockDestroy.mockResolvedValue([{ id: FLAG.id }]);

    const result = await deleteTraceFlags(
      server(),
      { ids: [FLAG.id, "7tf000000000009"] },
      ctx,
      policy(),
    );

    expect(mockDestroy).toHaveBeenCalledWith(expect.anything(), [FLAG.id], ctx.mcpReq.signal);
    expect(decode(text(result))).toEqual({
      org: "me@example.com (psa)",
      deletedCount: 1,
      notFoundCount: 1,
      notFoundIds: ["7tf000000000009"],
    });
  });

  it("should report a flag Salesforce refuses to delete as a row by cause", async () => {
    mockFind.mockResolvedValue(FOUND);
    mockDestroy.mockResolvedValue([{ id: FLAG.id, error: "insufficient access rights" }]);

    const result = await deleteTraceFlags(server(), { ids: [FLAG.id] }, ctx, policy());

    expect(decode(text(result))).toMatchObject({
      deletedCount: 0,
      failed: [{ error: "insufficient access rights", idCount: 1, ids: [FLAG.id] }],
    });
  });

  it("should ask production first, naming each flag, and delete nothing yet", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue(FOUND);

    const result = await deleteTraceFlags(server(), { ids: [FLAG.id] }, ctx, policy());

    expect(JSON.stringify(result)).toContain(`Stop logging: Jo (USER_DEBUG, ${FLAG.id})`);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it("should not ask production about ids that name no flag", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue([]);
    const mint = jest.fn();

    const result = await deleteTraceFlags(server(), { ids: [FLAG.id] }, ctx, policy({ mintConfirmationState: mint }));

    expect(mint).not.toHaveBeenCalled();
    expect(decode(text(result))).toMatchObject({ deletedCount: 0 });
  });
});
