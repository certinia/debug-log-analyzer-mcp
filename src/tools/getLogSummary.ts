/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import type { ApexLog, LogEvent } from "@apexdevtools/apex-log-parser";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import { toolInputSchema } from "./inputSchema.js";
import { listOperations, operationName, type Operation } from "./operations.js";
import {
  DEBUG_CATEGORIES,
  type DebugLevelCategory,
  type LogLevel,
} from "../salesforce/debugLevels.js";
import type {
  DebugCategory,
  DebugLevels,
  LineNumber,
  LogEventType,
  LogIssue,
} from "@apexdevtools/apex-log-parser/types";
import {
  elide,
  NAME_LIMIT,
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
    "Get a high-level summary of an Apex debug log: how long the transaction ran, where the time went by debug log category and the level each was logged at, every governor limit it and each namespace consumed, whether the log is complete, the exceptions and flow errors it raised, and what ended the transaction if it failed. Best for a quick overview.",
  inputSchema: toolInputSchema(getLogSummaryInputSchema),
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/**
 * One row per debug log category: the level it was captured at, and where the
 * transaction's time went under it.
 *
 * One table rather than two, because the level is what a zero row means: a
 * `database 0` beside `database NONE` means the queries were not logged, and
 * beside `database FINEST` means none ran.
 *
 * `level` is empty where the log's header declared none for the category, which
 * is most logs for `dataAccess`. A level has no zero, so empty says unstated
 * rather than off - naming a default would state a level the log did not, and
 * `NONE` typechecks, so the goldens are what hold the cell empty.
 */
interface CategoryRow {
  debugCategory: DebugLevelCategory;
  level: LogLevel | "";
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
 * every other figure means. It cannot be derived from the limits beside it -
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

/** A loop with a new message per throw has no bound; 409 real logs peak at 9. */
const EXCEPTION_ROW_LIMIT = 20;

/** The frames an `EXCEPTION_THROWN` line number can belong to. */
const THROWING_FRAMES: ReadonlySet<LogEventType | null> = new Set([
  "METHOD_ENTRY",
  "CONSTRUCTOR_ENTRY",
  "CODE_UNIT_STARTED",
]);

/** One row per exception message, placed where it was first thrown. */
interface ExceptionRow {
  /** The exception class and message, clipped as a fatal's is. */
  message: string;
  /** The nearest frame the log recorded, and empty where none encloses it. Below `APEX_CODE,FINE` the line can be in a method under it. */
  thrownIn: string;
  /** `EXTERNAL` where a managed package hides it, and empty where the log states none. */
  lineNumber: NonNullable<LineNumber> | "";
  thrownCount: number;
}

// On the message as shown, so no two rows read the same; one real log throws one message from 6 frames.
function exceptionRows(exceptions: LogEvent[]): ExceptionRow[] {
  const rows = new Map<string, ExceptionRow>();

  exceptions
    .filter((event) => event.type === "EXCEPTION_THROWN")
    .forEach((event) => {
      // The parser appends the "caused by" and stack lines; a fatal shows the first alone.
      const message = clip(event.text.split("\n", 1)[0] ?? "", FATAL_MESSAGE_LIMIT);
      const row = rows.get(message);
      if (row) {
        row.thrownCount += 1;
        return;
      }
      rows.set(message, {
        message,
        thrownIn: elide(frameName(event), NAME_LIMIT),
        lineNumber: event.lineNumber ?? "",
        thrownCount: 1,
      });
    });

  // A stable sort, so a tie keeps the order the throws happened in.
  return [...rows.values()].sort((a, b) => b.thrownCount - a.thrownCount);
}

// Named as a ranked operation is, so the caller can join the two.
function frameName(event: LogEvent): string {
  let frame = event.parent;
  while (frame && !THROWING_FRAMES.has(frame.type)) {
    frame = frame.parent;
  }
  return frame ? operationName(frame) : "";
}

// A flat pass over every event, cheaper than a second recursive walk of the tree.
function flowErrorCount(apexLog: ApexLog): number {
  return apexLog.eventsById.reduce(
    (count, event) =>
      event.type === "FLOW_ELEMENT_ERROR" ? count + 1 : count,
    0,
  );
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
  /** The distinct messages before the row cap, so a cut table says so. */
  exceptionGroupCount: number;
  exceptions?: ExceptionRow[];
  /** `FLOW_ELEMENT_ERROR` only: every real log with a `WF_FLOW_ACTION_ERROR` also has one. */
  flowErrorCount: number;
  fatalErrors?: FatalError[];
  namespaces: string[];
  governorLimits: LimitRow[];
  limitsByNamespace: NamespaceLimitRow[];
  categories: CategoryRow[];
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
  const exceptions = exceptionRows(apexLog.exceptions);

  // Every limit and every category is reported, zeros included: the caller has
  // to be able to say "no DML statements ran" without guessing from what is
  // absent.
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
    exceptionGroupCount: exceptions.length,
    ...omitEmpty({ exceptions: exceptions.slice(0, EXCEPTION_ROW_LIMIT) }),
    flowErrorCount: flowErrorCount(apexLog),
    ...omitEmpty({ fatalErrors: fatalErrors(apexLog.logIssues) }),
    namespaces: apexLog.namespaces,
    governorLimits: toLimitRows(apexLog.governorLimits.peak),
    limitsByNamespace: toNamespaceLimitRows(apexLog.governorLimits.byNamespace),
    categories: categories(
      apexLog.debugLevels,
      listOperations(apexLog),
      durationTotalNs,
    ),
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

function categories(
  debugLevels: DebugLevels,
  operations: Operation[],
  durationTotalNs: number,
): CategoryRow[] {
  // One total per category up front, so the categories nothing ran under are
  // still reported, at zero. The row set is the parser's `DebugLevels` keys
  // rather than a shorter list of our own, so a category it starts timing needs
  // no change here.
  const totals = DEBUG_CATEGORIES.map((debugCategory) => ({
    debugCategory,
    operationCount: 0,
    selfNs: 0,
  }));
  const byCategory = new Map<DebugCategory, (typeof totals)[number]>(
    totals.map((total) => [total.debugCategory, total]),
  );

  operations.forEach(({ debugCategory, durationSelfNs }) => {
    // Only `""` misses, which the parser never stamps on a timed event.
    const total = byCategory.get(debugCategory);
    if (total) {
      total.operationCount += 1;
      total.selfNs += durationSelfNs;
    }
  });

  // The header record is read directly rather than through `declaredLevels`,
  // which drops the categories it left unstated - the row set here is fixed, so
  // dropping them only to put them back says nothing.
  return totals.map(({ debugCategory, operationCount, selfNs }) => ({
    debugCategory,
    level: debugLevels[debugCategory] ?? "",
    operationCount,
    durationSelfMs: roundMs(selfNs / NS_TO_MS),
    selfPercentage: roundPercent(percentageOf(selfNs, durationTotalNs)),
  }));
}
