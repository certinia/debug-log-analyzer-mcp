/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";
import { decode } from "@toon-format/toon";

import { clearApexLogCache } from "../src/tools/apexLogSource";
import {
  listLimitRisks,
  listLimitRisksToolConfig,
  WARNING_THRESHOLD,
  type LimitRisksArgs,
  type LimitRiskResult,
} from "../src/tools/listLimitRisks";
import { parse } from "@apexdevtools/apex-log-parser";
import type { ApexLog } from "@apexdevtools/apex-log-parser";
import {
  ALL_LIMIT_METRICS,
  type GovernorLimits,
  type Limits,
} from "@apexdevtools/apex-log-parser/types";

jest.mock("fs", () => {
  const stat = jest.fn();
  const readFile = jest.fn();
  // A handle is the file at one path, so its stat and read delegate to the
  // mocks above with that path filled in. Tests set and assert on those.
  return {
    promises: {
      stat,
      readFile,
      open: jest.fn(async (path: string) => ({
        stat: (options: unknown) => stat(path, options),
        readFile: (encoding: unknown) => readFile(path, encoding),
        close: jest.fn(),
      })),
    },
  };
});

jest.mock("@apexdevtools/apex-log-parser", () => ({
  parse: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockParse = parse as jest.MockedFunction<typeof parse>;
const mockStats = {
  ino: 1n,
  size: 1n,
  mtimeNs: 1n,
  ctimeNs: 1n,
} as BigIntStats;

const ARGS: LimitRisksArgs = { logFilePath: "/test/file.log" };

type LimitUsage = { used: number; limit: number };
type LimitOverrides = Partial<Record<keyof Limits, LimitUsage>>;

/** The real org ceilings, so a percentage in a case is one a caller would see. */
const CEILINGS: Record<keyof Limits, number> = {
  soqlQueries: 100,
  soslQueries: 20,
  queryRows: 50000,
  dmlStatements: 150,
  publishImmediateDml: 10,
  dmlRows: 10000,
  cpuTime: 10000,
  heapSize: 6000000,
  callouts: 100,
  emailInvocations: 10,
  futureCalls: 50,
  queueableJobsAddedToQueue: 50,
  mobileApexPushCalls: 10,
};

// `percentUsed` is left null: no tool reads it, and a figure here would only
// let a case prove a scale nothing uses.
const limitsOf = (used: LimitOverrides): Limits =>
  Object.fromEntries(
    ALL_LIMIT_METRICS.map(({ key }) => [
      key,
      { used: 0, limit: CEILINGS[key], ...used[key], percentUsed: null },
    ]),
  ) as Limits;

function governorLimits(
  overrides: LimitOverrides = {},
  peakOverrides: LimitOverrides = overrides,
): GovernorLimits {
  return {
    snapshots: [],
    final: limitsOf(overrides),
    peak: limitsOf(peakOverrides),
    byNamespace: new Map(),
  };
}

function mockLog(
  overrides: LimitOverrides = {},
  peakOverrides?: LimitOverrides,
): void {
  mockFs.stat.mockResolvedValue(mockStats);
  mockFs.readFile.mockResolvedValue("log content");
  mockParse.mockReturnValue({
    governorLimits: governorLimits(overrides, peakOverrides),
    // A header these cases say nothing about, so no capture level is reported
    // and the assertions below are about the selection alone. The eval goldens
    // cover the levels, against fixtures that carry a real header.
    debugLevels: {},
  } as unknown as ApexLog);
}

async function risks(args: LimitRisksArgs = ARGS): Promise<LimitRiskResult> {
  const result = await listLimitRisks(args);
  return decode(result.content[0]!.text) as LimitRiskResult;
}

describe("listLimitRisks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The suites reuse one path with different content, which the cache would
    // otherwise hide.
    clearApexLogCache();
  });

  describe("tool configuration", () => {
    it("says which limits it covers, so a client can select it", () => {
      expect(listLimitRisksToolConfig.description).toContain(
        "governor limits",
      );
    });

    it("annotates only the hints that carry meaning for a read-only tool", () => {
      expect(listLimitRisksToolConfig.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
    });
  });

  it("reports a limit over the threshold, with what it cost", async () => {
    mockLog({ cpuTime: { used: 9500, limit: 10000 } });

    await expect(risks()).resolves.toEqual({
      threshold: WARNING_THRESHOLD,
      atRisk: [
        { limit: "cpuTime", used: 9500, max: 10000, usedPercentage: 95 },
      ],
    });
  });

  it("selects on the peak a limit reached, not where it ended", async () => {
    // A counter falls when the frame that spent it exits, so the final figure
    // can sit under a ceiling the transaction had already breached.
    mockLog(
      { cpuTime: { used: 100, limit: 10000 } },
      { cpuTime: { used: 9500, limit: 10000 } },
    );

    await expect(risks()).resolves.toEqual({
      threshold: WARNING_THRESHOLD,
      atRisk: [
        { limit: "cpuTime", used: 9500, max: 10000, usedPercentage: 95 },
      ],
    });
  });

  it("reports the worst limit first", async () => {
    mockLog({
      cpuTime: { used: 8500, limit: 10000 },
      soqlQueries: { used: 99, limit: 100 },
    });

    expect((await risks()).atRisk.map((risk) => risk.limit)).toEqual([
      "soqlQueries",
      "cpuTime",
    ]);
  });

  it("returns an empty table when every limit is comfortable", async () => {
    mockLog({ cpuTime: { used: 10, limit: 10000 } });

    // Reported rather than omitted: "nothing is at risk" is an answer, and an
    // absent table cannot be told apart from a limit block that never parsed.
    await expect(risks()).resolves.toEqual({
      threshold: WARNING_THRESHOLD,
      atRisk: [],
    });
  });

  it("reports a limit exactly at the threshold", async () => {
    mockLog({ cpuTime: { used: 8000, limit: 10000 } });

    expect((await risks()).atRisk).toHaveLength(1);
  });

  it("honours a caller threshold, and reports which one it used", async () => {
    mockLog({ cpuTime: { used: 5000, limit: 10000 } });

    await expect(risks({ ...ARGS, threshold: 50 })).resolves.toEqual({
      threshold: 50,
      atRisk: [
        { limit: "cpuTime", used: 5000, max: 10000, usedPercentage: 50 },
      ],
    });
  });

  it("skips a limit the log gave no ceiling for", async () => {
    mockLog({ cpuTime: { used: 9000, limit: 0 } });

    expect((await risks()).atRisk).toEqual([]);
  });

  it("names the real cause when the log cannot be read", async () => {
    mockFs.stat.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await expect(
      listLimitRisks({ logFilePath: "/nonexistent/file.log" }),
    ).rejects.toThrow("Log file not found: /nonexistent/file.log");
  });
});
