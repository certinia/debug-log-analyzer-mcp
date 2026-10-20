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
}));

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { AuthInfo, Org } from "@salesforce/core";
import { decode } from "@toon-format/toon";
import { listOrgLogs } from "../src/tools/listOrgLogs";
import { getOrgLogs } from "../src/tools/getOrgLogs";
import {
  connectOrg,
  readLocalOrg,
  type LocalOrg,
} from "../src/salesforce/connection";
import { classifyOrg } from "../src/salesforce/orgClassification";
import {
  downloadApexLog,
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

// A call that asked for progress, as the spec has it ask.
function progressCtx(
  notify: jest.Mock,
  signal: AbortSignal = ctx.mcpReq.signal,
): ServerContext {
  return {
    mcpReq: { ...ctx.mcpReq, signal, _meta: { progressToken: 7 }, notify },
  } as unknown as ServerContext;
}

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
  // Reset, not cleared, so no test inherits another's implementation.
  jest.resetAllMocks();
  root = mkdtempSync(path.join(tmpdir(), "org-logs-"));
  mockReadLocalOrg.mockResolvedValue(LOCAL_ORG);
  mockConnectOrg.mockResolvedValue({
    getConnection: () => connection,
  } as unknown as Org);
  // Reads need no confirmation, so production is the case worth proving.
  mockClassifyOrg.mockResolvedValue({ classification: "production" });
  mockDownload.mockResolvedValue("log");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
    const call = () =>
      getOrgLogs(server(), { ids: ["07L000000000001EAA"] }, ctx, policy());

    const results = await Promise.all([call(), call()]);

    for (const result of results) {
      expect(decode(text(result as never))).not.toHaveProperty("failed");
    }
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
    const notify = jest.fn().mockResolvedValue(undefined);

    await getOrgLogs(
      server(),
      { ids: ["07L000000000001AAA", "07L000000000002AAA"] },
      progressCtx(notify),
      policy(),
    );

    expect(notify.mock.calls.map(([note]) => note.params)).toEqual([
      { progressToken: 7, progress: 1, total: 2, message: expect.any(String) },
      { progressToken: 7, progress: 2, total: 2, message: expect.any(String) },
    ]);
  });

  // No result reaches a client that cancelled, so what counts is the work that stops.
  it("should download nothing more once the call is cancelled", async () => {
    const controller = new AbortController();
    mockDownload.mockImplementation(async () => {
      controller.abort();
      return "log";
    });
    const ids = Array.from({ length: 10 }, (_, i) => `07L0000000000${String(i).padStart(2, "0")}AAA`);

    await getOrgLogs(
      server(),
      { ids },
      { mcpReq: { ...ctx.mcpReq, signal: controller.signal } } as unknown as ServerContext,
      policy(),
    );

    // Only those already running when it was cancelled, however many the pool runs at once.
    expect(mockDownload.mock.calls.length).toBeLessThan(ids.length);
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
    const elsewhere = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await getOrgLogs(
      server(),
      { ids: ["07L000000000001EAA"], outputDir: elsewhere },
      ctx,
      policy(),
    );

    expect(decode(text(result as never))).toMatchObject({
      warning: expect.stringContaining("outside every root this client declared"),
    });
    consoleError.mockRestore();
    rmSync(elsewhere, { recursive: true, force: true });
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
