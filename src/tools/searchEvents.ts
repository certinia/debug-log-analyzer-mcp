/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import {
  LOG_EVENT_ID,
  namespaceOf,
  textOf,
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
  eventId: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only this event, with more of its text"),
  parentEventId: z
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
    `Search the events of an Apex debug log in log order: what the code printed (USER_DEBUG), validation rules, statements, or every event under one method. For plain text in the saved .log, grep is cheaper; use this for event types, nesting, or without a shell. Text past ${NAME_LIMIT} characters is elided; ask for one event by eventId to read up to ${ONE_EVENT_TEXT_LIMIT.toLocaleString("en-US")}.`,
  input: searchEventsInputSchema,
  run: searchEvents,
});

/** One event, in log order, as the payload carries it. */
export interface EventRow {
  /** The parser's stable id for the event, which `eventId` resolves. */
  eventId: number;
  /** The event it sits under, which `parentEventId` searches below. */
  parentEventId: number;
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

// What a row shows as text: none where the event states none, or only its type.
function shownText(event: ApexEvent): string {
  const text = textOf(event);
  return text === event.type ? "" : text;
}

// Kept around the `contains` match, so a cut cannot hide why the row matched.
function cut(text: string, maxChars: number, pattern: RegExp | undefined): string {
  const found = text.length > maxChars ? pattern?.exec(text) : undefined;
  return found
    ? elideAround(text, maxChars, found.index, found[0].length)
    : elide(text, maxChars);
}

// An index past the log names no event, and must not read as no match.
function resolve(apexLog: ApexLog, eventId: number, parameter: string): ApexEvent {
  const event = apexLog.event(eventId);
  if (!event) {
    throw new Error(`No event in this log has eventId ${eventId}. Pass as ${parameter} an eventId from a row this tool returned.`);
  }
  return event;
}

// No root is the log, which holds every event. By id: the parser makes a new object on each read.
function isBelow(event: ApexEvent, root: ApexEvent | undefined): boolean {
  if (!root) {
    return true;
  }
  for (let above = event.parent; above; above = above.parent) {
    if (above.id === root.id) {
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
    eventId,
    parentEventId,
    limit = 50,
    offset = 0,
  } = args;

  // Top-level rows name the log itself as their parent, so its id searches the whole log.
  const root =
    parentEventId === undefined || parentEventId === LOG_EVENT_ID
      ? undefined
      : resolve(apexLog, parentEventId, "parentEventId");
  // Rows name 0 as a parent, so an agent will pass it back as an event.
  if (eventId === LOG_EVENT_ID) {
    throw new Error(`eventId ${LOG_EVENT_ID} is the log itself, not an event. Pass it as parentEventId, or leave both out, to search the whole log.`);
  }
  const one = eventId === undefined ? undefined : resolve(apexLog, eventId, "eventId");

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
  if (one !== undefined) {
    if (isBelow(one, root)) {
      consider(one);
    }
  } else if (root) {
    root.children.forEach((child) => walkLog(child, consider));
  } else {
    // In log order, as the walk is, without an array of children per frame.
    for (const event of apexLog.events) {
      consider(event);
    }
  }

  // One event asked for by id is the way to read a long message, up to what a page may hold.
  const textLimit = eventId === undefined ? NAME_LIMIT : ONE_EVENT_TEXT_LIMIT;
  const toRow = (event: ApexEvent): EventRow => ({
    eventId: event.id,
    parentEventId: event.parent?.id ?? LOG_EVENT_ID,
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
