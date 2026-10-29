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

import type {
  ApexEvent,
  ApexLog,
  EventOf,
  EventType,
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
export { LEVEL, LIMIT_METRICS } from "@apexdevtools/apex-log-parser";

export { clearApexLogCache, loadApexLog, walkLog } from "./source.js";

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

/**
 * The namespace an event ran in, with `default` for none, or for no event.
 *
 * The parser gives null for an event in no namespace, which every response
 * has always called `default`. It copies a namespace down to a child that
 * states none, so this never looks at the parent - pinned in
 * `tests/parserContract.test.ts`.
 */
export function namespaceOf(event: Pick<ApexEvent, "namespace"> | null): string {
  return event?.namespace ?? "default";
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
  // A loop, to stop once every namespace is placed: on most logs that is within the first few events.
  for (const event of log.events) {
    named.add(namespaceOf(event));
    if (named.size > log.namespaces.length) {
      break;
    }
  }
  // A namespace no event is in, as one only a limit block names, follows in the parser's order.
  log.namespaces.forEach((namespace) => named.add(namespace));
  return [...named];
}
