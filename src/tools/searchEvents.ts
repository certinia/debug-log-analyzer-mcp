/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import {
  isEventOf,
  namespaceOf,
  walkLog,
  type ApexEvent,
  type ApexLog,
  type DebugCategory,
  type LineNumber,
} from "../apexLog/index.js";
import { defineAnalysisTool, type AnalysisArgs } from "./analysisTool.js";
import { capturedAt, declaredLevels, type DeclaredLevel } from "../logLevels.js";
import { elide, elideAround } from "../elide.js";
import {
  fitPage,
  matches,
  NAME_LIMIT,
  nextOffsetField,
  omitEmpty,
  PAGE_CHAR_BUDGET,
} from "./responseShaping.js";

const searchEventsInputSchema = {
  // Free strings, as on apexlog_list_slow_operations: an enum of the parser's
  // 299 event types would cost more than every other tool's definition.
  type: z
    .array(z.string())
    .optional()
    .describe("Only these log event types, e.g. USER_DEBUG, VALIDATION_RULE"),
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
    .describe("Page size (default: 50)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rows to skip (default: 0): the last page's nextOffset"),
};

// Half the page budget, so a message that escaping doubles still fits on the page.
const ONE_EVENT_TEXT_LIMIT = PAGE_CHAR_BUDGET / 2;

export type SearchEventsArgs = AnalysisArgs<typeof searchEventsInputSchema>;

export const searchEventsTool = defineAnalysisTool({
  name: "apexlog_search_events",
  title: "Search Apex Log Events",
  description:
    `Search the events of an Apex debug log in log order: what the code printed (USER_DEBUG), validation rules, statements, or every event under one method. For plain text in the saved .log, grep is cheaper; use this for event types, nesting, or without a shell. Text past ${NAME_LIMIT} characters is elided; ask for one event by eventIndex to read up to ${ONE_EVENT_TEXT_LIMIT.toLocaleString("en-US")}.`,
  input: searchEventsInputSchema,
  run: searchEvents,
});

/** One event, in log order, as the payload carries it. */
export interface EventRow {
  /** The parser's stable id for the event, which `eventIndex` resolves. */
  eventIndex: number;
  /** The event it sits under, which `parentEventIndex` searches below. */
  parentEventIndex: number;
  type: string;
  /** On every row, though most rows share one: hoisting a shared namespace to one field saved 0-12 tokens a response on the eval logs, and none where namespaces mix. */
  namespace: string;
  /** The Apex line, `EXTERNAL` for code outside the org, or null where the log states none. */
  lineNumber: LineNumber;
  /** Empty where the event states none; cut past `NAME_LIMIT`, or past `ONE_EVENT_TEXT_LIMIT` for one event asked for by id, around the `contains` match when there is one. */
  text: string;
}

export interface SearchEventsResult {
  /**
   * Events the filters matched, before `offset`, `limit` or the page budget cut
   * them. Above the returned count it says rows were held back.
   */
  matchedCount: number;
  /**
   * The level each category searched was captured at: those every match came
   * from when each `type` named matched or one event was asked for. Otherwise,
   * or when these name no declared category, every level the header declared:
   * a category with no match may have none only because its level did not
   * capture it. On the first page, or for one event, since a later page reads the same log.
   */
  capturedAt?: DeclaredLevel[];
  events: EventRow[];
  /** The `offset` of the next page, while matches remain past this one. */
  nextOffset?: number;
}

/** The log's own id: every top-level event names it as its parent. */
const LOG_ID = 0;

// What a row shows as text: none where the event states none, or only its type.
// A flow error's text is its message alone; the element that failed is in `details`.
function shownText(event: ApexEvent): string {
  const text = event.text ?? "";
  if (isEventOf(event, "FLOW_ELEMENT_ERROR")) {
    const { elementType, elementName } = event.details;
    return [text, elementType, elementName].filter(Boolean).join(" ");
  }
  return text === event.type ? "" : text;
}

// Kept around the `contains` match, so a cut cannot hide why the row matched.
function cut(text: string, maxChars: number, pattern: RegExp | undefined): string {
  const found = text.length > maxChars ? pattern?.exec(text) : undefined;
  return found
    ? elideAround(text, maxChars, found.index, found[0].length)
    : elide(text, maxChars);
}

// An index that names no event - past the log, or the log itself - must not read as no match.
function resolve(apexLog: ApexLog, eventIndex: number, parameter: string): ApexEvent {
  const event = apexLog.event(eventIndex);
  if (!event) {
    throw new Error(`No event in this log has eventIndex ${eventIndex}. Pass as ${parameter} an eventIndex from a row this tool returned.`);
  }
  return event;
}

// By id: the parser makes a new object on each read, so two reads of one event are not `===`.
function isBelow(event: ApexEvent, rootId: number): boolean {
  if (rootId === LOG_ID) {
    return true;
  }
  for (let above = event.parent; above; above = above.parent) {
    if (above.id === rootId) {
      return true;
    }
  }
  return false;
}

function searchEvents(apexLog: ApexLog, args: SearchEventsArgs): SearchEventsResult {
  const {
    type,
    namespace,
    contains,
    eventIndex,
    parentEventIndex,
    limit = 50,
    offset = 0,
  } = args;

  // Top-level rows name the log itself as their parent, so its index searches the whole log.
  const root: ApexLog | ApexEvent =
    parentEventIndex === undefined || parentEventIndex === LOG_ID
      ? apexLog
      : resolve(apexLog, parentEventIndex, "parentEventIndex");
  const rootId = parentEventIndex ?? LOG_ID;
  const one = eventIndex === undefined ? undefined : resolve(apexLog, eventIndex, "eventIndex");

  // One pattern per call, so no event's text is copied to compare it.
  const pattern =
    contains === undefined
      ? undefined
      : new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  // Counted in one pass, keeping only the page, so a 200,000-event log costs no array of its matches.
  let matchedCount = 0;
  const page: ApexEvent[] = [];
  const matchedTypes = new Set<string>();
  const matchedCategories = new Set<DebugCategory>();
  const consider = (event: ApexEvent): void => {
    const kept =
      matches(type, event.type) &&
      matches(namespace, namespaceOf(event)) &&
      (pattern === undefined || pattern.test(shownText(event)));
    if (!kept) {
      return;
    }
    if (matchedCount >= offset && matchedCount < offset + limit) {
      page.push(event);
    }
    matchedCount++;
    matchedTypes.add(event.type);
    matchedCategories.add(event.debugCategory);
  };
  if (one === undefined) {
    root.children.forEach((child) => walkLog(child, consider));
  } else if (isBelow(one, rootId)) {
    consider(one);
  }

  // One event asked for by id is the way to read a long message, up to what a page may hold.
  const textLimit = eventIndex === undefined ? NAME_LIMIT : ONE_EVENT_TEXT_LIMIT;
  const toRow = (event: ApexEvent): EventRow => ({
    eventIndex: event.id,
    parentEventIndex: event.parent?.id ?? LOG_ID,
    type: event.type,
    namespace: namespaceOf(event),
    lineNumber: event.lineNumber,
    text: cut(shownText(event), textLimit, pattern),
  });

  const events = fitPage(page, toRow).rows;
  // Only these fix the categories searched; a type that matched nothing names no category.
  const allTypesSeen =
    !!type?.length && type.every((name) => matchedTypes.has(name));
  const levels = capturedAt(apexLog, one || allTypesSeen ? matchedCategories : []);

  const result: SearchEventsResult = {
    matchedCount,
    ...((offset === 0 || one) &&
      omitEmpty({
        capturedAt: levels.length ? levels : declaredLevels(apexLog),
      })),
    events,
    ...nextOffsetField(offset, events.length, matchedCount),
  };

  return result;
}
