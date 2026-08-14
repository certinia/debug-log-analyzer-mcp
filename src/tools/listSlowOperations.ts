/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import {
  captureLevels,
  GROUP_BY,
  groupOperations,
  listOperations,
  OPERATION_KINDS,
  type CaptureLevels,
  type Operation,
  type OperationKind,
} from "./operations.js";
import { NS_TO_MS, roundMs, roundPercent } from "./responseShaping.js";

export const listSlowOperationsInputSchema = {
  logFilePath: logFilePathSchema,
  kind: z
    .enum(OPERATION_KINDS)
    .optional()
    .describe("Rank only operations of this kind"),
  namespace: z.string().optional().describe("Rank only this namespace"),
  minSelfMs: z
    .number()
    .optional()
    .describe("Drop operations below this self time (default: 0)"),
  limit: z.number().optional().describe("Rows to return (default: 10)"),
  groupBy: z
    .enum([...GROUP_BY, "none"])
    .optional()
    .describe(
      "Fold repeats into one row: by name (default), by namespace, or by callerNamespace, which attributes platform DML to the package that drove it. A grouped durationTotalMs is what the transaction takes back if the group never runs — never sum it across rows. Pass none to rank each call on its own.",
    ),
};

export type SlowOperationsArgs = z.infer<
  z.ZodObject<typeof listSlowOperationsInputSchema>
>;

export const listSlowOperationsToolConfig = {
  title: "List Slow Apex Log Operations",
  description:
    "Rank what an Apex debug log spent its time on by self-execution time — code units, methods, queries, searches, DML, flows and workflows in one table, each row with its calls, durations, database counts and rows, so the caller can see what to optimize and why.",
  inputSchema: listSlowOperationsInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/** One ranked row, in the units and the order the payload uses. */
export interface SlowOperation {
  kind: OperationKind;
  name: string;
  namespace: string;
  /** On a grouped row, the line of the slowest call in the group. */
  lineNumber: string | number | null;
  callCount: number;
  /**
   * On a grouped row, what the transaction takes back if the group never runs.
   * Never additive across rows — one row's callees are another row's calls.
   */
  durationTotalMs: number;
  durationSelfMs: number;
  /** Absent on an ungrouped row, where it is `durationSelfMs` again. */
  durationSelfMaxMs?: number;
  selfPercentage: number;
  soqlCount: number;
  dmlCount: number;
  soslCount: number;
  rowCount: number;
  thrownCount: number;
}

export interface SlowOperationsResult extends CaptureLevels {
  durationTotalMs: number;
  /**
   * Share of the transaction the returned rows account for between them. A low
   * figure says the cost is spread across everything else rather than
   * concentrated here — the one thing the table itself does not say.
   */
  returnedSelfPercentage: number;
  operations: SlowOperation[];
}

export async function listSlowOperations(args: SlowOperationsArgs) {
  const {
    logFilePath,
    kind,
    namespace,
    minSelfMs = 0,
    limit = 10,
    groupBy = "name",
  } = args;

  const apexLog = await loadApexLog(logFilePath);
  const durationTotalNs = apexLog.duration.total;
  const minSelfNs = minSelfMs * NS_TO_MS;

  const selected = listOperations(apexLog).filter(
    (operation) =>
      (!kind || operation.kind === kind) &&
      (!namespace || operation.namespace === namespace),
  );

  const grouped = groupBy !== "none";

  // Grouped before the threshold, so a query that is slow only because it runs
  // four hundred times is kept rather than dropped call by call.
  const rows = grouped ? groupOperations(selected, groupBy) : selected;

  const ranked = rows
    // Tested as ">= keep" rather than "< drop": a malformed timestamp parses to
    // NaN, which fails both, and such an operation must be dropped, not ranked.
    .filter((operation) => operation.durationSelfNs >= minSelfNs)
    .sort((a, b) => b.durationSelfNs - a.durationSelfNs)
    .slice(0, limit);

  const selfPercentageOf = (operation: Operation) =>
    durationTotalNs > 0 ? (operation.durationSelfNs / durationTotalNs) * 100 : 0;

  // The column set is spelled out rather than spread, so the compiler fails the
  // build if an `Operation` field is added without deciding whether it belongs
  // on the wire, and so the columns arrive in a readable order. It is a fixed
  // set: a zero SOQL count reads as "none" rather than "not measured".
  const operations: SlowOperation[] = ranked.map((operation) => ({
    kind: operation.kind,
    name: operation.name,
    namespace: operation.namespace,
    lineNumber: operation.lineNumber,
    callCount: operation.callCount,
    durationTotalMs: roundMs(operation.durationTotalNs / NS_TO_MS),
    durationSelfMs: roundMs(operation.durationSelfNs / NS_TO_MS),
    // On an ungrouped row the slowest call is the row itself, and a response
    // states each figure once.
    ...(grouped && {
      durationSelfMaxMs: roundMs(operation.durationSelfMaxNs / NS_TO_MS),
    }),
    selfPercentage: roundPercent(selfPercentageOf(operation)),
    soqlCount: operation.soqlCount,
    dmlCount: operation.dmlCount,
    soslCount: operation.soslCount,
    rowCount: operation.rowCount,
    thrownCount: operation.thrownCount,
  }));

  const result: SlowOperationsResult = {
    ...captureLevels(apexLog),
    durationTotalMs: roundMs(durationTotalNs / NS_TO_MS),
    returnedSelfPercentage: roundPercent(
      ranked.reduce((total, operation) => total + selfPercentageOf(operation), 0),
    ),
    operations,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: encode(result),
      },
    ],
  };
}
