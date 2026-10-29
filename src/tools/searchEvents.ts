/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import {
  LOG_EVENT_ID,
  namespaceAt,
  namespaceOf,
  textAt,
  textOf,
  typeAt,
  type ApexEvent,
  type ApexLog,
  type DebugCategory,
  type EventType,
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
function shownText(text: string, type: EventType): string {
  return text === type ? "" : text;
}

// Kept around the `contains` match, so a cut cannot hide why the row matched.
function cut(text: string, maxChars: number, pattern: RegExp | undefined): string {
  const found = text.length > maxChars ? pattern?.exec(text) : undefined;
  return found
    ? elideAround(text, maxChars, found.index, found[0].length)
    : elide(text, maxChars);
}

// An index past the log names no event, and must not read as no match.
function assertEvent(apexLog: ApexLog, eventId: number, parameter: string): void {
  if (eventId > apexLog.columns.count) {
    throw new Error(`No event in this log has eventId ${eventId}. Pass as ${parameter} an eventId from a row this tool returned.`);
  }
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
  const root = parentEventId ?? LOG_EVENT_ID;
  assertEvent(apexLog, root, "parentEventId");
  // Rows name 0 as a parent, so an agent will pass it back as an event.
  if (eventId === LOG_EVENT_ID) {
    throw new Error(`eventId ${LOG_EVENT_ID} is the log itself, not an event. Pass it as parentEventId, or leave both out, to search the whole log.`);
  }
  if (eventId !== undefined) {
    assertEvent(apexLog, eventId, "eventId");
  }

  // One pattern per call, so no event's text is copied to compare it.
  const pattern =
    contains === undefined
      ? undefined
      : new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  // From the columns, so no event object is made but for the page, and no
  // text is read unless `contains` asks for it. Counted in one pass, keeping
  // only the page, so a 200,000-event log costs no array of its matches.
  const { columns } = apexLog;
  const { type: types, namespace: namespaces } = columns;
  let matchedCount = 0;
  const page: number[] = [];
  const matchedTypes = new Set<string>();
  const matchedCategories = new Set<DebugCategory>();
  // Every event below the root, in log order: the ids from the root's own to
  // its subtree's end. The log is row 0, whose subtree is every event.
  const end = columns.subtreeEnd[root] ?? 0;
  // The text column's first read indexes every event's text, 75 ms on a 95 MB
  // log where reading each event's text through its event took 101 ms for the
  // whole log - so the column only for a scan of most of it.
  const textFromColumn = eventId === undefined && (end - root - 1) * 2 > columns.count;
  const textOfId = (id: number): string => {
    const event = textFromColumn ? null : apexLog.event(id);
    return event ? textOf(event) : textAt(apexLog, id);
  };
  const consider = (id: number): void => {
    const info = typeAt(types, id);
    if (
      !info ||
      !matches(type, info.type) ||
      // Read only when asked for: most searches name no namespace.
      (namespace !== undefined && !matches(namespace, namespaceAt(namespaces, id))) ||
      (pattern !== undefined && !pattern.test(shownText(textOfId(id), info.type)))
    ) {
      return;
    }
    if (matchedCount >= offset && matchedCount < offset + limit) {
      page.push(id);
    }
    matchedCount++;
    matchedTypes.add(info.type);
    matchedCategories.add(info.debugCategory);
  };
  if (eventId !== undefined) {
    if (eventId > root && eventId < end) {
      consider(eventId);
    }
  } else {
    for (let id = root + 1; id < end; id++) {
      consider(id);
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
    text: cut(shownText(textOf(event), event.type), textLimit, pattern),
  });

  // Every id on the page is one `consider` read from the columns.
  const pageEvents = page.flatMap((id) => apexLog.event(id) ?? []);
  const events = fitPage(pageEvents, toRow).rows;
  // Only these fix the categories searched; a type that matched nothing names no category.
  const allTypesSeen =
    !!type?.length && type.every((name) => matchedTypes.has(name));
  const levels = capturedAt(apexLog, eventId !== undefined || allTypesSeen ? matchedCategories : []);

  const result: SearchEventsResult = {
    matchedCount,
    ...((offset === 0 || eventId !== undefined) &&
      omitEmpty({
        capturedAt: levels.length ? levels : declaredLevels(apexLog),
      })),
    events,
    ...nextOffsetField(offset, events.length, matchedCount),
  };

  return result;
}
