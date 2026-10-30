/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * The one module that imports `@apexdevtools/apex-log-parser`; a lint rule
 * refuses it anywhere else. A parser change then touches this module and the
 * fields the tools read, and no import beyond it.
 *
 * The tools still read the parser's own events and types, under the parser's
 * names: a copy into types of our own would cost a pass over every event.
 */

import { DEFAULT_NAMESPACE, eventType } from "@apexdevtools/apex-log-parser";
import type {
  ApexEvent,
  ApexLog,
  Columns,
  CountColumn,
  EventOf,
  EventType,
  EventTypeInfo,
  LimitValue,
  SelfTotal,
} from "@apexdevtools/apex-log-parser";

export type {
  ApexEvent,
  ApexLog,
  DebugCategory,
  EventType,
  GovernorLimits,
  LimitMetric,
  LimitUnit,
  Limits,
  LogIssue,
  NamespaceLimits,
} from "@apexdevtools/apex-log-parser";
export { DEFAULT_NAMESPACE, ENDED_BY, LEVEL, LIMIT_METRICS } from "@apexdevtools/apex-log-parser";
// For the test builder, which the lint rule keeps from the parser.
export type { Columns, CountColumn } from "@apexdevtools/apex-log-parser";
export { eventType } from "@apexdevtools/apex-log-parser";

/** The log's own id: an event at the top of the log has it as its parent's. */
export const LOG_EVENT_ID = 0;

export { clearApexLogCache, loadApexLog } from "./source.js";

// The `*At` helpers read event `id` from a column, not from an event object,
// which the parser makes on each read. Each takes the column it reads, so a
// loop takes it from `log.columns` once: a getter per event cost
// `apexlog_get_summary` half again its time on logs of 10-50 MB.

/** The type of event `id`; null for no event. */
export function typeAt(types: Columns["type"], id: number): EventTypeInfo | null {
  return eventType(types[id] ?? -1);
}

/**
 * The type of event `id` when it is a frame, else null. A frame is what the
 * parser times: every event with a duration is one, pinned in
 * `tests/parserContract.test.ts`. A leaf is most of a log, so it is the first test.
 */
export function frameTypeAt(
  { isFrame, type }: Pick<Columns, "isFrame" | "type">,
  id: number,
): EventTypeInfo | null {
  return isFrame[id] ? typeAt(type, id) : null;
}

/** Whether `event` is of `type`, so its `details` read as that type's. */
export function isEventOf<T extends EventType>(event: ApexEvent, type: T): event is EventOf<T> & ApexEvent {
  return event.type === type;
}

/** An event's line number: as the log states it, `EXTERNAL`, or null where it states none. */
export type LineNumber = ApexEvent["lineNumber"];

const NONE: SelfTotal = Object.freeze({ self: 0, total: 0 });

/**
 * A count the log did not record, as zero.
 *
 * The parser gives null where the header's level hides a count's lines and the
 * log holds none. Every response reports these counts as zeros beside
 * `capturedAt`, which says whether the level could have recorded them. To show
 * "not recorded" instead, change this and the callers that format it.
 */
export function countOf(rollup: SelfTotal | null): SelfTotal {
  return rollup ?? NONE;
}

/** `countOf(...).total` for event `id`; the column is null where `countOf` gives zero. */
export function totalAt(column: CountColumn | null, id: number): number {
  return column?.total[id] ?? 0;
}

/** A limit's ceiling, with 0 where the log stated none, which every response has always reported. */
export function ceilingOf({ limit }: LimitValue): number {
  return limit ?? 0;
}

/**
 * What an event says, with "" where it says nothing.
 *
 * A flow error's text is its message alone; the element that failed is in
 * `details`, and follows the message here, as it did in the log line.
 */
export function textOf(event: ApexEvent): string {
  const text = event.text ?? "";
  if (isEventOf(event, "FLOW_ELEMENT_ERROR")) {
    const { elementType, elementName } = event.details;
    return [text, elementType, elementName].filter(Boolean).join(" ");
  }
  return text;
}

const FLOW_ELEMENT_ERROR = eventType("FLOW_ELEMENT_ERROR").typeId;

/**
 * `textOf` for event `id`, read from the text column. The one `*At` helper that
 * takes the log: a flow error's element is in `details`, which only its event reads.
 */
export function textAt(log: ApexLog, id: number): string {
  const { type, text } = log.columns;
  const event = type[id] === FLOW_ELEMENT_ERROR ? log.event(id) : null;
  return event ? textOf(event) : (text.at(id) ?? "");
}

/**
 * The namespace event `id` ran in, `DEFAULT_NAMESPACE` for code in no package.
 * The column is null only for an id that is no event, as the log's own row 0.
 */
export function namespaceAt(namespaces: Columns["namespace"], id: number): string {
  return namespaces.at(id) ?? DEFAULT_NAMESPACE;
}

/**
 * The warning for a file the parser read only part of, with the count of logs
 * it found; undefined when it read the whole file.
 *
 * The parser stops at the second log header and raises `Multiple-Logs`, whose
 * description - pinned in `tests/parserContract.test.ts` - counts the logs. Of
 * its issues this is the one that leaves bytes of the file unread. It also
 * stops at a header that a debug line quotes, so the warning names both causes.
 * The parser's own text is worded for a UI ("Open each log").
 */
export function multipleLogsWarning(log: ApexLog): string | undefined {
  const issue = log.issues.find(({ summary }) => summary === "Multiple-Logs");
  if (!issue) {
    return undefined;
  }
  const count = /(\d+) logs/.exec(issue.description)?.[1] ?? "more than one";
  return `This file holds ${count} debug logs, or a debug line in it quotes a log header. This answer covers only the text before the second header. Pass each log as its own file.`;
}
