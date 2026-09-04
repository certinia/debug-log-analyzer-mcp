/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import {
  declaredLevels,
  listOperations,
  logCategoryOf,
  OPERATION_KINDS,
  type Operation,
  type OperationKind,
} from "./operations.js";
import type { LogIssue } from "@apexdevtools/apex-log-parser/types";
import {
  NS_TO_MS,
  omitEmpty,
  percentageOf,
  roundMs,
  roundPercent,
  toLimitRows,
  toNamespaceLimitRows,
  type LimitRow,
  type NamespaceLimitRow,
} from "./responseShaping.js";

export const getLogSummaryInputSchema = {
  logFilePath: logFilePathSchema,
};

export type LogSummaryArgs = z.infer<
  z.ZodObject<typeof getLogSummaryInputSchema>
>;

export const getLogSummaryToolConfig = {
  title: "Get Apex Log Summary",
  description:
    "Get a high-level summary of an Apex debug log: how long the transaction ran, where the time went by kind of operation, every governor limit it and each namespace consumed, the debug levels it was logged at, whether the log is complete, and what ended the transaction if it failed. Best for a quick overview before deeper analysis.",
  inputSchema: getLogSummaryInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/**
 * Where the transaction's time went, one row per kind of operation.
 *
 * `logCategory` is the trace category that decides whether the kind reaches the
 * log at all, so a zero row can be read against `debugLevels`: `soql 0` beside
 * `DB NONE` means the queries were not logged, and beside `DB FINEST` means
 * none ran.
 */
interface KindRow {
  kind: OperationKind;
  logCategory: string;
  operationCount: number;
  durationSelfMs: number;
  selfPercentage: number;
}

/** Frames beyond this cost more than they say; one real log states 52,009 characters of stack. */
const FATAL_FRAME_LIMIT = 3;

/**
 * Where an exception message stops being the failure and starts being prose.
 *
 * A DML failure embeds the whole validation message a user would see: 53
 * characters on the median of 124 real logs, 1,070 at the worst. The first 200
 * keep the exception class, the offending row and the error code.
 */
const FATAL_MESSAGE_LIMIT = 200;

/**
 * The whole frame cell, not one frame: a single frame runs to 1,081 characters
 * on a 124-log corpus, so capping the count alone leaves the cell unbounded.
 */
const FATAL_FRAMES_LIMIT = 400;

/**
 * Sliced text is a view on its parent, so the join is what stops 201 characters
 * pinning the 52 KB they were cut from. The cut backs off a code unit where it
 * would split a surrogate pair, because a message carries text a user typed.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const splitsPair = text.codePointAt(limit - 1)! > 0xffff;
  return [text.slice(0, splitsPair ? limit - 1 : limit), "…"].join("");
}

interface FatalError {
  /** The exception message the log states, clipped where it runs into prose. */
  message: string;
  /**
   * The innermost frames of the stack, and empty when the log stated none. A
   * trailing `…` says frames were dropped, which half of a 124-log corpus has.
   * Always present, so every row shares one key set and TOON holds the table to
   * one header and one line per row.
   */
  frames: string;
}

/**
 * The failures that ended a transaction.
 *
 * Read from `logIssues` rather than `exceptions`, because the parser dedupes an
 * issue on its type and message: 4,501 throws in one real log are three
 * messages, where `exceptions` holds every occurrence.
 *
 * The only field that says the transaction did not finish, which decides what
 * every other figure means. It cannot be derived from the limits beside it —
 * across 124 real logs, 18 of 42 fatals breach no governor limit at all.
 */
function fatalErrors(logIssues: LogIssue[]): FatalError[] {
  return logIssues
    .filter((issue) => issue.type === "fatal")
    .map(({ summary, description }) => ({
      message: clip(summary, FATAL_MESSAGE_LIMIT),
      frames: innermostFrames(description),
    }));
}

/**
 * Blank lines are dropped before the limit is counted against, not after, so a
 * description that holds one still reports `FATAL_FRAME_LIMIT` real frames and
 * says frames were dropped only where a real one was.
 */
function innermostFrames(description: string): string {
  const frames: string[] = [];
  let dropped = false;

  for (const line of description.split("\n")) {
    const frame = line.trim();
    if (frame.length === 0) {
      continue;
    }
    if (frames.length === FATAL_FRAME_LIMIT) {
      dropped = true;
      break;
    }
    frames.push(frame);
  }

  const shown = dropped ? [...frames, "…"].join(" | ") : frames.join(" | ");

  return clip(shown, FATAL_FRAMES_LIMIT);
}

interface LogSummaryResult {
  fileSizeBytes: number;
  durationTotalMs: number;
  /** True when the log is partial, so every figure in it is a floor, not a total. */
  truncated: boolean;
  /**
   * How the log lost content: `skipped-lines` for a hole in the middle,
   * `max-size` for a tail that was never written. Both call for different
   * reading, and a log can carry both.
   */
  truncatedBy?: string[];
  /**
   * The bytes the platform said it skipped, which only a `skipped-lines` region
   * states. Gated on the platform having truncated the log, so 0 beside a
   * `max-size` region means the extent of that loss is unstated rather than nil.
   */
  skippedBytes?: number;
  thrownCount: number;
  fatalErrors?: FatalError[];
  namespaces: string[];
  debugLevels: { logCategory: string; level: string }[];
  governorLimits: LimitRow[];
  limitsByNamespace: NamespaceLimitRow[];
  timeByKind: KindRow[];
}

export async function getLogSummary(args: LogSummaryArgs) {
  const { logFilePath } = args;

  const apexLog = await loadApexLog(logFilePath);
  const durationTotalNs = apexLog.duration.total;
  // The platform dropping content and the log stopping mid-frame are different
  // shapes and neither implies the other, but the field means the same thing for
  // both: every figure is a floor. Reading a CPU time off either as though it
  // were a total is the worst answer this server can give.
  const truncated =
    apexLog.isTruncated || apexLog.truncatedEvents.length > 0;

  // Every limit and every kind is reported, at zero included: the caller has to
  // be able to say "no DML statements ran" and "DB logging was off, so that
  // detail is missing" without guessing from what is absent.
  const summary: LogSummaryResult = {
    fileSizeBytes: apexLog.size,
    durationTotalMs: roundMs(durationTotalNs / NS_TO_MS),
    truncated,
    // Both come from `truncation.regions`, which only the platform's own
    // truncation fills. A log that merely stops mid-frame has none, and
    // reporting the pair off `truncated` said the platform skipped 0 bytes for
    // no stated reason, where it had skipped nothing at all.
    ...(apexLog.isTruncated && {
      truncatedBy: [
        ...new Set(apexLog.truncation.regions.map((region) => region.kind)),
      ],
      skippedBytes: apexLog.truncation.totalSkippedBytes,
    }),
    thrownCount: apexLog.thrownCount.total,
    ...omitEmpty({ fatalErrors: fatalErrors(apexLog.logIssues) }),
    namespaces: apexLog.namespaces,
    debugLevels: declaredLevels(apexLog),
    governorLimits: toLimitRows(apexLog.governorLimits.peak),
    limitsByNamespace: toNamespaceLimitRows(apexLog.governorLimits.byNamespace),
    timeByKind: timeByKind(listOperations(apexLog), durationTotalNs),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: encode(summary),
      },
    ],
  };
}

function timeByKind(
  operations: Operation[],
  durationTotalNs: number,
): KindRow[] {
  // Seeded with every kind, so the loop only ever adds to a row that is there
  // and the kinds nothing ran under are still reported, at zero.
  const totals = Object.fromEntries(
    OPERATION_KINDS.map((kind) => [kind, { operationCount: 0, selfNs: 0 }]),
  ) as Record<OperationKind, { operationCount: number; selfNs: number }>;

  operations.forEach(({ kind, durationSelfNs }) => {
    const total = totals[kind];
    total.operationCount += 1;
    total.selfNs += durationSelfNs;
  });

  return OPERATION_KINDS.map((kind) => {
    const { operationCount, selfNs } = totals[kind];
    return {
      kind,
      logCategory: logCategoryOf(kind),
      operationCount,
      durationSelfMs: roundMs(selfNs / NS_TO_MS),
      selfPercentage: roundPercent(percentageOf(selfNs, durationTotalNs)),
    };
  });
}
