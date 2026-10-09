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

jest.mock("../src/salesforce/apexLogs", () => ({
  ...jest.requireActual("../src/salesforce/apexLogs"),
  listApexLogs: jest.fn(),
  readCursor: jest.fn(),
  latestApexLogIds: jest.fn(),
  downloadApexLog: jest.fn(),
  findApexLogs: jest.fn(),
  deleteApexLogs: jest.fn(),
}));

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { AuthInfo, Org } from "@salesforce/core";
import { decode } from "@toon-format/toon";
import { listOrgLogs } from "../src/tools/listOrgLogs";
import { getOrgLogs } from "../src/tools/getOrgLogs";
import { deleteOrgLogs } from "../src/tools/deleteOrgLogs";
import {
  connectOrg,
  readLocalOrg,
  type LocalOrg,
} from "../src/salesforce/connection";
import { classifyOrg } from "../src/salesforce/orgClassification";
import {
  deleteApexLogs,
  downloadApexLog,
  findApexLogs,
  latestApexLogIds,
  listApexLogs,
  readCursor,
} from "../src/salesforce/apexLogs";
import { compileDenyList } from "../src/policy/orgDenyList";
import { createConfirmationLedger } from "../src/policy/orgExecutionPolicy";
import type { OrgAccessPolicy } from "../src/salesforce/orgAccess";

const mockReadLocalOrg = readLocalOrg as jest.MockedFunction<typeof readLocalOrg>;
const mockConnectOrg = connectOrg as jest.MockedFunction<typeof connectOrg>;
const mockClassifyOrg = classifyOrg as jest.MockedFunction<typeof classifyOrg>;
const mockListApexLogs = listApexLogs as jest.MockedFunction<typeof listApexLogs>;
const mockLatest = latestApexLogIds as jest.MockedFunction<typeof latestApexLogIds>;
const mockDownload = downloadApexLog as jest.MockedFunction<typeof downloadApexLog>;
const mockReadCursor = readCursor as jest.MockedFunction<typeof readCursor>;
const mockFind = findApexLogs as jest.MockedFunction<typeof findApexLogs>;
const mockDelete = deleteApexLogs as jest.MockedFunction<typeof deleteApexLogs>;

const LOCAL_ORG: LocalOrg = {
  orgId: "00D000000000001",
  username: "me@example.com",
  aliases: ["psa"],
  authInfo: {} as AuthInfo,
};

const connection = { tag: "connection" };
let root: string;

function server(): McpServer {
  return {
    server: {
      listRoots: jest
        .fn()
        .mockResolvedValue({ roots: [{ uri: `file://${root}` }] }),
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

const text = (result: { content: { text: string }[] }) =>
  result.content[0]!.text;

beforeEach(() => {
  jest.clearAllMocks();
  root = mkdtempSync(path.join(tmpdir(), "org-logs-"));
  mockReadLocalOrg.mockResolvedValue(LOCAL_ORG);
  mockConnectOrg.mockResolvedValue({
    getConnection: () => connection,
  } as unknown as Org);
  // Reads need no confirmation, so production is the case worth proving.
  mockClassifyOrg.mockResolvedValue({ classification: "production" });
});

describe("listOrgLogs", () => {
  it("should list against production without asking, with the defaults stated", async () => {
    mockListApexLogs.mockResolvedValue({ rows: [], matchedCount: 0 });

    const result = await listOrgLogs(server(), {}, ctx, policy());

    expect(mockListApexLogs).toHaveBeenCalledWith(connection, {
      filters: {},
      sortBy: "startTime",
      limit: 20,
      after: undefined,
    });
    expect(decode(text(result as never))).toEqual({
      org: "me@example.com (psa)",
      sortBy: "startTime",
      matchedCount: 0,
      logs: [],
    });
  });

  it("should pass the filters, sort and cursor on, and give the next cursor back", async () => {
    const after = { value: 50, id: "07L000000000001EAA", matchedCount: 3000 };
    mockReadCursor.mockReturnValue(after);
    mockListApexLogs.mockResolvedValue({
      rows: [],
      matchedCount: 3000,
      nextCursor: "next",
    });

    const result = await listOrgLogs(
      server(),
      { operation: "aura", succeeded: false, sortBy: "durationTotalMs", limit: 5, cursor: "c" },
      ctx,
      policy(),
    );

    expect(mockListApexLogs).toHaveBeenCalledWith(connection, {
      filters: expect.objectContaining({ operation: "aura", succeeded: false }),
      sortBy: "durationTotalMs",
      limit: 5,
      after,
    });
    expect(mockReadCursor).toHaveBeenCalledWith(
      "c",
      "durationTotalMs",
      expect.objectContaining({ operation: "aura" }),
    );
    expect(decode(text(result as never))).toMatchObject({ nextCursor: "next" });
  });

  it("should refuse a cursor from another list before connecting", async () => {
    mockReadCursor.mockImplementation(() => {
      throw new Error("cursor belongs to a list with other filters");
    });

    await expect(
      listOrgLogs(server(), { cursor: "c" }, ctx, policy()),
    ).rejects.toThrow("cursor belongs to a list with other filters");
    expect(mockConnectOrg).not.toHaveBeenCalled();
  });

  // A log holds the org's data, so a deny covers reading it.
  it("should refuse a denied org before connecting", async () => {
    const result = await listOrgLogs(
      server(),
      {},
      ctx,
      policy({ denyList: compileDenyList(["psa"]) }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(text(result as never)).toContain(
      "Cannot list debug logs against org 'me@example.com (psa)'",
    );
    expect(mockConnectOrg).not.toHaveBeenCalled();
    expect(mockListApexLogs).not.toHaveBeenCalled();
  });
});

describe("getOrgLogs", () => {
  it("should download the newest log when given neither ids nor latest", async () => {
    mockLatest.mockResolvedValue(["07L000000000001EAA"]);
    mockDownload.mockResolvedValue("67.0 APEX_CODE,FINE");

    const result = await getOrgLogs(server(), {}, ctx, policy());

    expect(mockLatest).toHaveBeenCalledWith(connection, 1);
    const filePath = path.join(root, ".apex-log-mcp", "07L000000000001EAA.log");
    expect(decode(text(result as never))).toEqual({
      org: "me@example.com (psa)",
      logs: [
        { id: "07L000000000001EAA", filePath, fileSizeBytes: 19, downloaded: true },
      ],
      outputDirCreated: true,
    });
    expect(readFileSync(filePath, "utf8")).toBe("67.0 APEX_CODE,FINE");
  });

  // A stored log never changes, so the same id is the same text.
  it("should not download a log already saved", async () => {
    const outputDir = path.join(root, "logs");
    await getOrgLogs(server(), { ids: ["07L000000000001EAA"], outputDir }, ctx, policy());
    writeFileSync(path.join(outputDir, "07L000000000002EAA.log"), "saved");
    mockDownload.mockClear();
    mockDownload.mockResolvedValue("downloaded");

    const result = await getOrgLogs(
      server(),
      { ids: ["07L000000000002EAA"], outputDir },
      ctx,
      policy(),
    );

    expect(mockDownload).not.toHaveBeenCalled();
    expect(decode(text(result as never))).toMatchObject({
      logs: [{ id: "07L000000000002EAA", fileSizeBytes: 5, downloaded: false }],
      outputDirCreated: false,
    });
  });

  it("should report a log that fails as a row, and still save the rest", async () => {
    mockDownload.mockImplementation(async (_c, id) => {
      if (id === "07L000000000009EAA") {
        throw new Error("invalid parameter value");
      }
      return "log";
    });

    const result = await getOrgLogs(
      server(),
      { ids: ["07L000000000001EAA", "07L000000000009EAA"] },
      ctx,
      policy(),
    );

    expect(decode(text(result as never))).toMatchObject({
      logs: [{ id: "07L000000000001EAA", downloaded: true }],
      failed: [{ id: "07L000000000009EAA", error: "invalid parameter value" }],
    });
  });

  it("should download a log once whether named by its 15- or 18-character id", async () => {
    mockDownload.mockResolvedValue("log");

    const result = await getOrgLogs(
      server(),
      { ids: ["07LRL00000QFiGK", "07LRL00000QFiGK2A1"] },
      ctx,
      policy(),
    );

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledWith(connection, "07LRL00000QFiGK2A1");
    expect(decode(text(result as never))).toMatchObject({
      logs: [{ id: "07LRL00000QFiGK2A1" }],
    });
  });

  it("should save one id from two calls at once, failing neither", async () => {
    mockDownload.mockResolvedValue("log");
    const call = () =>
      getOrgLogs(server(), { ids: ["07L000000000001EAA"] }, ctx, policy());

    const results = await Promise.all([call(), call()]);

    for (const result of results) {
      expect(decode(text(result as never))).not.toHaveProperty("failed");
    }
  });

  it("should download a repeated id once", async () => {
    mockDownload.mockResolvedValue("log");

    const result = await getOrgLogs(
      server(),
      { ids: ["07L000000000001EAA", "07L000000000001EAA"] },
      ctx,
      policy(),
    );

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(decode(text(result as never))).toMatchObject({
      logs: [{ id: "07L000000000001EAA" }],
    });
  });

  it("should make no directory when the org holds no logs", async () => {
    mockLatest.mockResolvedValue([]);

    const result = await getOrgLogs(server(), { latest: 5 }, ctx, policy());

    expect(decode(text(result as never))).toEqual({
      org: "me@example.com (psa)",
      logs: [],
      outputDirCreated: false,
    });
    expect(existsSync(path.join(root, ".apex-log-mcp"))).toBe(false);
  });

  it("should report each log saved as progress, out of every log asked for", async () => {
    mockDownload.mockResolvedValue("log");
    const notify = jest.fn().mockResolvedValue(undefined);

    await getOrgLogs(
      server(),
      { ids: ["07L000000000001AAA", "07L000000000002AAA"] },
      { mcpReq: { ...ctx.mcpReq, _meta: { progressToken: 7 }, notify } } as unknown as ServerContext,
      policy(),
    );

    expect(notify.mock.calls.map(([note]) => note.params)).toEqual([
      { progressToken: 7, progress: 1, total: 2, message: "1 of 2 logs" },
      { progressToken: 7, progress: 2, total: 2, message: "2 of 2 logs" },
    ]);
  });

  // No result reaches a client that cancelled, so what counts is the work that stops.
  it("should download nothing more once the call is cancelled", async () => {
    const controller = new AbortController();
    mockDownload.mockImplementation(async () => {
      controller.abort();
      return "log";
    });
    const ids = Array.from({ length: 6 }, (_, i) => `07L00000000000${i}AAA`);

    await getOrgLogs(
      server(),
      { ids },
      { mcpReq: { ...ctx.mcpReq, signal: controller.signal } } as unknown as ServerContext,
      policy(),
    );

    // The four already running when it was cancelled.
    expect(mockDownload).toHaveBeenCalledTimes(4);
  });

  it("should refuse ids and latest together, before touching the org", async () => {
    const result = await getOrgLogs(
      server(),
      { ids: ["07L000000000001EAA"], latest: 2 },
      ctx,
      policy(),
    );

    expect(result).toMatchObject({ isError: true });
    expect(text(result as never)).toBe("Give ids or latest, not both.");
    expect(mockReadLocalOrg).not.toHaveBeenCalled();
  });

  it("should warn when outputDir is outside every root", async () => {
    mockDownload.mockResolvedValue("log");
    const elsewhere = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await getOrgLogs(
      server(),
      { ids: ["07L000000000001EAA"], outputDir: elsewhere },
      ctx,
      policy(),
    );

    expect(decode(text(result as never))).toMatchObject({
      warning: expect.stringContaining("outside every root this client declared"),
    });
  });

  it("should refuse a denied org before connecting", async () => {
    const result = await getOrgLogs(
      server(),
      {},
      ctx,
      policy({ denyList: compileDenyList(["type:production"]) }),
    );

    expect(text(result as never)).toContain(
      "Cannot download debug logs against org 'me@example.com (psa)'",
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe("deleteOrgLogs", () => {
  beforeEach(() => {
    mockClassifyOrg.mockResolvedValue({ classification: "scratch" });
  });

  // Leaving every filter out, or giving one that narrows nothing, must not read as "delete every log".
  it.each([
    ["no ids and no filter", {}],
    ["an empty operation", { operation: "" }],
    ["a zero minFileSizeBytes", { minFileSizeBytes: 0 }],
  ])("should refuse %s, before touching the org", async (_name, args) => {
    const result = await deleteOrgLogs(server(), args, ctx, policy());

    expect(text(result as never)).toContain("Give ids or at least one filter");
    expect(mockReadLocalOrg).not.toHaveBeenCalled();
  });

  it("should refuse ids and filters together", async () => {
    const result = await deleteOrgLogs(
      server(),
      { ids: ["07L000000000001EAA"], succeeded: false },
      ctx,
      policy(),
    );

    expect(text(result as never)).toBe("Give ids or filters, not both.");
  });

  it("should delete what the filters match, and count it", async () => {
    mockFind.mockResolvedValue({
      logs: [
        { id: "07L000000000001EAA", fileSizeBytes: 100 },
        { id: "07L000000000002EAA", fileSizeBytes: 50 },
      ],
      matchedCount: 2,
    });
    mockDelete.mockResolvedValue([
      { id: "07L000000000001EAA" },
      { id: "07L000000000002EAA" },
    ]);

    const result = await deleteOrgLogs(
      server(),
      { startTimeTo: "2026-10-09T09:00:00Z", user: undefined },
      ctx,
      policy(),
    );

    expect(mockFind).toHaveBeenCalledWith(connection, {
      filters: { startTimeTo: "2026-10-09T09:00:00Z" },
    });
    expect(decode(text(result as never))).toEqual({
      org: "me@example.com (psa)",
      deletedCount: 2,
      deletedBytes: 150,
      remainingCount: 0,
    });
  });

  it("should report a failed delete and an id that names no log as rows, and count the rest", async () => {
    mockFind.mockResolvedValue({
      logs: [
        { id: "07L000000000001EAA", fileSizeBytes: 100 },
        { id: "07L000000000002EAA", fileSizeBytes: 50 },
      ],
      matchedCount: 2,
    });
    mockDelete.mockResolvedValue([
      { id: "07L000000000001EAA" },
      { id: "07L000000000002EAA", error: "insufficient access rights" },
    ]);

    const result = await deleteOrgLogs(
      server(),
      { ids: ["07L000000000001EAA", "07L000000000002EAA", "07L000000000009EAA"] },
      ctx,
      policy(),
    );

    expect(decode(text(result as never))).toMatchObject({
      deletedCount: 1,
      deletedBytes: 100,
      failed: [
        { id: "07L000000000002EAA", error: "insufficient access rights" },
        { id: "07L000000000009EAA", error: "no stored log has this id" },
      ],
    });
  });

  it("should report an unknown id in the form it was sent", async () => {
    mockFind.mockResolvedValue({ logs: [], matchedCount: 0 });
    mockDelete.mockResolvedValue([]);

    const result = await deleteOrgLogs(
      server(),
      { ids: ["07L000000000009"] },
      ctx,
      policy(),
    );

    expect(mockFind).toHaveBeenCalledWith(connection, {
      ids: ["07L000000000009EAA"],
    });
    expect(decode(text(result as never))).toMatchObject({
      failed: [{ id: "07L000000000009", error: "no stored log has this id" }],
    });
  });

  // A no-op is not a destructive act, so a person is not asked to confirm one.
  it("should not ask production to confirm when nothing matches", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue({ logs: [], matchedCount: 0 });
    mockDelete.mockResolvedValue([]);
    const mint = jest.fn();

    const result = await deleteOrgLogs(
      server(),
      { user: "nobody@example.com" },
      ctx,
      policy({ mintConfirmationState: mint }),
    );

    expect(mint).not.toHaveBeenCalled();
    expect(decode(text(result as never))).toEqual({
      org: "me@example.com (psa)",
      deletedCount: 0,
      deletedBytes: 0,
      remainingCount: 0,
    });
  });

  it("should say how many more match than one call deletes", async () => {
    mockFind.mockResolvedValue({
      logs: [{ id: "07L000000000001EAA", fileSizeBytes: 100 }],
      matchedCount: 10_001,
    });
    mockDelete.mockResolvedValue([{ id: "07L000000000001EAA" }]);

    const result = await deleteOrgLogs(
      server(),
      { succeeded: true },
      ctx,
      policy(),
    );

    expect(decode(text(result as never))).toMatchObject({ remainingCount: 10_000 });
  });

  const PAST = "2026-10-09T09:00:00Z";

  it("should ask before deleting from production, naming the count and the condition, and delete nothing yet", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue({
      logs: [
        { id: "07L000000000001EAA", fileSizeBytes: 100 },
        { id: "07L000000000002EAA", fileSizeBytes: 50 },
        { id: "07L000000000003EAA", fileSizeBytes: 25 },
      ],
      matchedCount: 3,
    });

    const result = await deleteOrgLogs(
      server(),
      // The empty value narrows nothing, so the condition shown must leave it out.
      { user: "me@example.com", request: "", startTimeTo: PAST },
      ctx,
      policy(),
    );

    const shown = JSON.stringify(result);
    expect(shown).toContain(
      "3 debug logs, 175 bytes. Every log where LogUser.Username = 'me@example.com' AND StartTime <= 2026-10-09T09:00:00.000Z.",
    );
    expect(shown).toContain("cannot be restored");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  // Without the bound, a log filed while the person reads could join what they were shown.
  it.each([
    ["no startTimeTo", {}],
    ["a startTimeTo in the future", { startTimeTo: "2099-01-01T00:00:00Z" }],
  ])("should refuse a production delete by filter with %s", async (_name, extra) => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue({
      logs: [{ id: "07L000000000001EAA", fileSizeBytes: 1 }],
      matchedCount: 1,
    });

    const result = await deleteOrgLogs(
      server(),
      { succeeded: true, ...extra },
      ctx,
      policy(),
    );

    expect(text(result as never)).toContain("needs startTimeTo, no later than now");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  // Bound to what was asked, so logs that expire while the person reads do not void it.
  it("should bind a production confirmation to the filters, not to the logs found", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    const mint = jest.fn();
    const digest = async (ids: string[], args: object) => {
      mockFind.mockResolvedValue({
        logs: ids.map((id) => ({ id, fileSizeBytes: 1 })),
        matchedCount: ids.length,
      });
      await deleteOrgLogs(server(), { startTimeTo: PAST, ...args }, ctx, policy({ mintConfirmationState: mint }));
      return mint.mock.calls.at(-1)[0].effectDigest;
    };

    const shown = await digest(["07L000000000001EAA", "07L000000000002EAA"], { succeeded: true });

    expect(await digest(["07L000000000001EAA"], { succeeded: true })).toBe(shown);
    expect(await digest(["07L000000000001EAA"], { succeeded: false })).not.toBe(shown);
  });

  it("should show the ids found, not every id given", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue({
      logs: [{ id: "07L000000000001EAA", fileSizeBytes: 1 }],
      matchedCount: 1,
    });

    const result = await deleteOrgLogs(
      server(),
      { ids: ["07L000000000001EAA", "07L000000000002EAA"] },
      ctx,
      policy(),
    );

    expect(JSON.stringify(result)).toContain("By id: 07L000000000001EAA.");
  });

  it("should show how many match in all when one call deletes only some", async () => {
    mockClassifyOrg.mockResolvedValue({ classification: "production" });
    mockFind.mockResolvedValue({
      logs: [{ id: "07L000000000001EAA", fileSizeBytes: 10 }],
      matchedCount: 40_000,
    });

    const result = await deleteOrgLogs(
      server(),
      { succeeded: true, startTimeTo: PAST },
      ctx,
      policy(),
    );

    expect(JSON.stringify(result)).toContain(
      "1 of the 40000 debug logs that match, the oldest first; call again for the rest",
    );
  });

  // Failed logs still hold storage, so an agent looping until zero must see them.
  it("should count failed deletes as still remaining", async () => {
    mockFind.mockResolvedValue({
      logs: [
        { id: "07L000000000001EAA", fileSizeBytes: 1 },
        { id: "07L000000000002EAA", fileSizeBytes: 1 },
      ],
      matchedCount: 2,
    });
    mockDelete.mockResolvedValue([
      { id: "07L000000000001EAA" },
      { id: "07L000000000002EAA", error: "insufficient access rights" },
    ]);

    const result = await deleteOrgLogs(server(), { succeeded: true }, ctx, policy());

    expect(decode(text(result as never))).toMatchObject({
      deletedCount: 1,
      remainingCount: 1,
    });
  });

  it("should pass the call's cancel signal to the delete", async () => {
    mockFind.mockResolvedValue({
      logs: [{ id: "07L000000000001EAA", fileSizeBytes: 1 }],
      matchedCount: 1,
    });
    mockDelete.mockResolvedValue([{ id: "07L000000000001EAA" }]);

    await deleteOrgLogs(server(), { succeeded: true }, ctx, policy());

    expect(mockDelete).toHaveBeenCalledWith(
      connection,
      ["07L000000000001EAA"],
      ctx.mcpReq.signal,
    );
  });

  it("should refuse a denied org before connecting", async () => {
    const result = await deleteOrgLogs(
      server(),
      { succeeded: true },
      ctx,
      policy({ denyList: compileDenyList(["psa"]) }),
    );

    expect(text(result as never)).toContain(
      "Cannot delete debug logs against org 'me@example.com (psa)'",
    );
    expect(mockConnectOrg).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
  });
});
