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

import { eventType } from "@apexdevtools/apex-log-parser";
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
  Columns,
  CountColumn,
  DebugCategory,
  EventType,
  EventTypeInfo,
  GovernorLimits,
  LimitMetric,
  LimitUnit,
  Limits,
  LogIssue,
  NamespaceLimits,
} from "@apexdevtools/apex-log-parser";
export { ENDED_BY, eventType, LEVEL, LIMIT_METRICS } from "@apexdevtools/apex-log-parser";

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

const NO_NAMESPACE = "default";

/**
 * The namespace an event ran in, with `default` for none, or for no event.
 *
 * The parser gives null for an event in no namespace, which every response
 * has always called `default`. It copies a namespace down to a child that
 * states none, so this never looks at the parent - pinned in
 * `tests/parserContract.test.ts`.
 */
export function namespaceOf(event?: Pick<ApexEvent, "namespace">): string {
  return event?.namespace ?? NO_NAMESPACE;
}

/** `namespaceOf` for event `id`. */
export function namespaceAt(namespaces: Columns["namespace"], id: number): string {
  return namespaces.at(id) ?? NO_NAMESPACE;
}

/**
 * Every namespace the log states, `default` among them where an event is in
 * none, in the order each first appears.
 *
 * The parser lists only the namespaces a line names, so this adds `default`
 * where `namespaceOf` first reports it. Once the parser lists `default` itself,
 * this is `log.namespaces`.
 */
export function namespacesOf(log: ApexLog): string[] {
  const named = new Set<string>();
  // A loop, to stop at the first `default`, the one name the parser does not
  // list: on most logs that is within the first few events. The parser lists
  // the rest in the order they first appear, so they follow in its order.
  const { count, namespace: namespaces } = log.columns;
  for (let id = 1; id <= count; id++) {
    const namespace = namespaceAt(namespaces, id);
    named.add(namespace);
    if (namespace === NO_NAMESPACE) {
      break;
    }
  }
  log.namespaces.forEach((namespace) => named.add(namespace));
  return [...named];
}
