/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  listLimitRisksTool,
  WARNING_THRESHOLD,
  type LimitRisksArgs,
  type LimitRiskResult,
} from "../src/tools/listLimitRisks";
import { LIMIT_METRICS } from "../src/apexLog";
import type {
  ApexLog,
  GovernorLimits,
  LimitMetric,
  Limits,
} from "../src/apexLog";

type LimitUsage = { used: number; limit: number | null };
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
    (Object.keys(LIMIT_METRICS) as LimitMetric[]).map((key) => [
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

function logWith(
  overrides: LimitOverrides = {},
  peakOverrides?: LimitOverrides,
): ApexLog {
  return {
    limits: governorLimits(overrides, peakOverrides),
    // A header these cases say nothing about, so no capture level is reported
    // and the assertions below are about the selection alone. The eval goldens
    // cover the levels, against fixtures that carry a real header.
    debugLevels: {},
  } as unknown as ApexLog;
}

function risks(apexLog: ApexLog, args: LimitRisksArgs = {}): LimitRiskResult {
  return listLimitRisksTool.run(apexLog, args);
}

describe("listLimitRisks", () => {
  it("says which limits it covers, so a client can select it", () => {
    expect(listLimitRisksTool.config.description).toContain("governor limits");
  });

  it("reports a limit over the threshold, with what it cost", () => {
    expect(risks(logWith({ cpuTime: { used: 9500, limit: 10000 } }))).toEqual({
      threshold: WARNING_THRESHOLD,
      atRisk: [
        { limit: "cpuTime", used: 9500, max: 10000, usedPercentage: 95 },
      ],
    });
  });

  it("selects on the peak a limit reached, not where it ended", () => {
    // A counter falls when the frame that spent it exits, so the final figure
    // can sit under a ceiling the transaction had already breached.
    const apexLog = logWith(
      { cpuTime: { used: 100, limit: 10000 } },
      { cpuTime: { used: 9500, limit: 10000 } },
    );

    expect(risks(apexLog)).toEqual({
      threshold: WARNING_THRESHOLD,
      atRisk: [
        { limit: "cpuTime", used: 9500, max: 10000, usedPercentage: 95 },
      ],
    });
  });

  it("reports the worst limit first", () => {
    const apexLog = logWith({
      cpuTime: { used: 8500, limit: 10000 },
      soqlQueries: { used: 99, limit: 100 },
    });

    expect(risks(apexLog).atRisk.map((risk) => risk.limit)).toEqual([
      "soqlQueries",
      "cpuTime",
    ]);
  });

  it("returns an empty table when every limit is comfortable", () => {
    // Reported rather than omitted: "nothing is at risk" is an answer, and an
    // absent table cannot be told apart from a limit block that never parsed.
    expect(risks(logWith({ cpuTime: { used: 10, limit: 10000 } }))).toEqual({
      threshold: WARNING_THRESHOLD,
      atRisk: [],
    });
  });

  it("reports a limit exactly at the threshold", () => {
    expect(risks(logWith({ cpuTime: { used: 8000, limit: 10000 } })).atRisk).toHaveLength(1);
  });

  it("honours a caller threshold, and reports which one it used", () => {
    const apexLog = logWith({ cpuTime: { used: 5000, limit: 10000 } });

    expect(risks(apexLog, { threshold: 50 })).toEqual({
      threshold: 50,
      atRisk: [
        { limit: "cpuTime", used: 5000, max: 10000, usedPercentage: 50 },
      ],
    });
  });

  // The parser states no ceiling as null; a zero ceiling is no ceiling either.
  it.each([null, 0])("skips a limit the log gave no ceiling for (%s)", (limit) => {
    expect(risks(logWith({ cpuTime: { used: 9000, limit } })).atRisk).toEqual([]);
  });
});
