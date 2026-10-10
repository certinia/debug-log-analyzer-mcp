/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import type {
  ApexLog,
  DebugCategory,
  LineNumber,
  LogEvent,
} from "@apexdevtools/apex-log-parser";
import { loadApexLog, logFilePathSchema, walkLog } from "./apexLogSource.js";
import { toolInputSchema } from "./inputSchema.js";
import { capturedAt, declaredLevels, type DeclaredLevel } from "./operations.js";
import { DEBUG_CATEGORIES, LOG_LEVELS } from "../salesforce/debugLevels.js";
import {
  elide,
  fitPage,
  matches,
  NAME_LIMIT,
  omitEmpty,
  PAGE_CHAR_BUDGET,
  toonResult,
} from "./responseShaping.js";

export const searchEventsInputSchema = {
  logFilePath: logFilePathSchema,
  // Free strings, as on apexlog_list_slow_operations: an enum of the parser's
  // 290 event types would cost more than every other tool's definition.
  type: z
    .array(z.string())
    .optional()
    .describe("Only these log event types, e.g. USER_DEBUG, VALIDATION_RULE"),
  debugCategory: z
    .array(z.enum(DEBUG_CATEGORIES))
    .optional()
    .describe("Only these debug log categories"),
  maxLevel: z
    .enum(LOG_LEVELS)
    .optional()
    .describe("Only events a log captured at this level carries"),
  namespace: z.array(z.string()).optional().describe("Only these namespaces"),
  contains: z
    .string()
    .optional()
    .describe("Only events whose text holds this, ignoring case"),
  eventIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only this event, with more of its text"),
  parentEventIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only events below this one"),
  limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Page size (default: 50); fewer if the page would be too large"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Matched rows to skip (default: 0). Advance it by the rows you got, which can be fewer than limit.",
    ),
};

// Half the page budget, so a message that escaping doubles still fits on the page.
const ONE_EVENT_TEXT_LIMIT = PAGE_CHAR_BUDGET / 2;

export type SearchEventsArgs = z.infer<
  z.ZodObject<typeof searchEventsInputSchema>
>;

export const searchEventsToolConfig = {
  title: "Search Apex Log Events",
  description:
    `Search the events of an Apex debug log in log order: what the code printed (USER_DEBUG), validation rules, statements, or every event under one method. Each row gives the event's eventIndex, its parent's, its type, category, namespace, line and text, with no timing. Text past ${NAME_LIMIT} characters is elided; ask for one event by eventIndex to read up to ${ONE_EVENT_TEXT_LIMIT.toLocaleString("en-US")}.`,
  inputSchema: toolInputSchema(searchEventsInputSchema),
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/** One event, in log order, as the payload carries it. */
export interface EventRow {
  /** The parser's stable id for the event, which `eventIndex` resolves. */
  eventIndex: number;
  /** The event it sits under, which `parentEventIndex` searches below. */
  parentEventIndex: number;
  type: string;
  debugCategory: DebugCategory;
  namespace: string;
  /** The Apex line, `EXTERNAL` for code outside the org, or null where the log states none. */
  lineNumber: LineNumber;
  /** Empty where the event states none; elided past `NAME_LIMIT`, or past `ONE_EVENT_TEXT_LIMIT` for one event asked for by id. */
  text: string;
}

export interface SearchEventsResult {
  /**
   * Events the filters matched, before `offset`, `limit` or the page budget cut
   * them. Above the returned count it says rows were held back.
   */
  matchedCount: number;
  /**
   * The level each category searched was captured at: those the `debugCategory`
   * filter names, or else those every match came from when each `type` named
   * matched or one event was asked for. Otherwise, or when these name no
   * declared category, every level the header declared: a category with no
   * match may have none only because its level did not capture it.
   */
  capturedAt?: DeclaredLevel[];
  events: EventRow[];
}

const LEVEL_RANK = new Map<string, number>(
  LOG_LEVELS.map((level, rank) => [level, rank]),
);

// The parser stamps every USER_DEBUG as DEBUG; the line itself states the level the code logged at.
function levelOf(event: LogEvent): string {
  if (event.type !== "USER_DEBUG") {
    return event.debugLevel;
  }
  const stated = /^[A-Z]+/.exec(event.text)?.[0] ?? "";
  return LEVEL_RANK.has(stated) ? stated : event.debugLevel;
}

// What a row shows as text: none where the parser named the event after its type.
function shownText(event: LogEvent): string {
  return event.text === event.type ? "" : event.text;
}

// An index that names nothing in the tree - past the log, or a line the parser folded - must not read as no match.
function resolve(apexLog: ApexLog, eventIndex: number): LogEvent {
  const event = apexLog.eventsById[eventIndex];
  if (!event?.parent?.children.includes(event)) {
    throw new Error(`No event in this log has eventIndex ${eventIndex}.`);
  }
  return event;
}

function isBelow(event: LogEvent, root: LogEvent): boolean {
  for (let above = event.parent; above; above = above.parent) {
    if (above === root) {
      return true;
    }
  }
  return false;
}

export async function searchEvents(args: SearchEventsArgs) {
  const {
    logFilePath,
    type,
    debugCategory,
    maxLevel,
    namespace,
    contains,
    eventIndex,
    parentEventIndex,
    limit = 50,
    offset = 0,
  } = args;

  const apexLog = await loadApexLog(logFilePath);
  // Top-level rows name the log itself as their parent, so its index searches the whole log.
  const root: LogEvent =
    parentEventIndex === undefined || parentEventIndex === apexLog.eventIndex
      ? apexLog
      : resolve(apexLog, parentEventIndex);
  const one = eventIndex === undefined ? undefined : resolve(apexLog, eventIndex);

  const maxRank = maxLevel === undefined ? undefined : LEVEL_RANK.get(maxLevel);
  // One pattern per call, so no event's text is copied to compare it.
  const pattern =
    contains === undefined
      ? undefined
      : new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  // Counted in one pass, keeping only the page, so a 200,000-event log costs no array of its matches.
  let matchedCount = 0;
  const page: LogEvent[] = [];
  const matchedTypes = new Set<string>();
  const matchedCategories = new Set<DebugCategory>();
  const consider = (event: LogEvent): void => {
    const kept =
      matches(type, event.type ?? "") &&
      matches(debugCategory, event.debugCategory) &&
      matches(namespace, event.namespace) &&
      // An event that states no level is kept: nothing says a level hides it.
      (maxRank === undefined ||
        (LEVEL_RANK.get(levelOf(event)) ?? -1) <= maxRank) &&
      (pattern === undefined || pattern.test(shownText(event)));
    if (!kept) {
      return;
    }
    if (matchedCount >= offset && matchedCount < offset + limit) {
      page.push(event);
    }
    matchedCount++;
    matchedTypes.add(event.type ?? "");
    matchedCategories.add(event.debugCategory);
  };
  if (one === undefined) {
    // An exit line is in the tree only where the log lost its entry, so each one visited is kept.
    root.children.forEach((child) => walkLog(child, consider));
  } else if (isBelow(one, root)) {
    consider(one);
  }

  // One event asked for by id is the way to read a long message, up to what a page may hold.
  const textLimit = eventIndex === undefined ? NAME_LIMIT : ONE_EVENT_TEXT_LIMIT;
  const toRow = (event: LogEvent): EventRow => ({
    eventIndex: event.eventIndex,
    // In range: every event in the tree has a parent.
    parentEventIndex: event.parent!.eventIndex,
    type: event.type ?? "",
    debugCategory: event.debugCategory,
    namespace: event.namespace,
    lineNumber: event.lineNumber,
    text: elide(shownText(event), textLimit),
  });

  const events = fitPage(page, toRow).rows;
  // Only these fix the categories searched; a type that matched nothing names no category.
  const allTypesSeen =
    !!type?.length && type.every((name) => matchedTypes.has(name));
  const searched = debugCategory?.length
    ? debugCategory
    : one || allTypesSeen
      ? matchedCategories
      : [];
  const levels = capturedAt(apexLog, searched);

  const result: SearchEventsResult = {
    matchedCount,
    ...omitEmpty({
      capturedAt: levels.length ? levels : declaredLevels(apexLog),
    }),
    events,
  };

  return toonResult(result);
}
