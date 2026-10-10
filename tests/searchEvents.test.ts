/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decode } from "@toon-format/toon";

import {
  searchEvents,
  type SearchEventsArgs,
  type SearchEventsResult,
} from "../src/tools/searchEvents";

const FIXTURES = join(__dirname, "eval", "fixtures");

// A value read with `!` that is missing still fails the test, as a TypeError.

async function searchAt(
  logFilePath: string,
  args: Omit<SearchEventsArgs, "logFilePath"> = {},
): Promise<SearchEventsResult> {
  const result = await searchEvents({ logFilePath, ...args });
  return decode(result.content[0]!.text) as unknown as SearchEventsResult;
}

function search(
  fixture: string,
  args: Omit<SearchEventsArgs, "logFilePath"> = {},
): Promise<SearchEventsResult> {
  return searchAt(join(FIXTURES, `${fixture}.log`), args);
}

// The default page, a search by type and an empty search are pinned by the eval goldens.
describe("searchEvents", () => {
  it("should walk on from offset, with the same matchedCount", async () => {
    const first = await search("governor-heavy", { limit: 10 });
    const next = await search("governor-heavy", { limit: 10, offset: 10 });

    expect(next.matchedCount).toBe(first.matchedCount);
    expect(next.events[0]!.eventIndex).toBeGreaterThan(
      first.events[9]!.eventIndex,
    );
  });

  it("should match text ignoring case", async () => {
    const { events } = await search("exceptions", {
      contains: "callOUTexception",
    });

    expect(events).toHaveLength(3);
    expect(events.every((row) => row.type === "EXCEPTION_THROWN")).toBe(true);
  });

  // A log at DEBUG drops the FINE and finer events, which is the noise.
  it("should keep only events a log captured at maxLevel carries", async () => {
    const { events } = await search("governor-heavy", {
      maxLevel: "INFO",
      limit: 1000,
    });
    const types = new Set(events.map((row) => row.type));

    expect(types.has("SOQL_EXECUTE_BEGIN")).toBe(true);
    expect(types.has("METHOD_ENTRY")).toBe(false);
    expect(types.has("SOQL_EXECUTE_EXPLAIN")).toBe(false);
  });

  it("should return only the events below parentEventIndex", async () => {
    const all = await search("governor-heavy", { limit: 1000 });
    const method = all.events.find((row) => row.type === "METHOD_ENTRY")!;

    const { events } = await search("governor-heavy", {
      parentEventIndex: method.eventIndex,
      limit: 1000,
    });

    const below = new Set([method.eventIndex]);
    for (const row of events) {
      expect(below.has(row.parentEventIndex)).toBe(true);
      below.add(row.eventIndex);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  // A long message is elided in a list, and read whole by asking for it.
  it("should elide text past 400 characters unless one event is asked for", async () => {
    const listed = await search("governor-heavy", {
      type: ["CUMULATIVE_PROFILING"],
    });
    const row = listed.events[0]!;

    const asked = await search("governor-heavy", { eventIndex: row.eventIndex });

    expect(row.text).toHaveLength(400);
    expect(row.text).toContain("…");
    expect(asked.events[0]!.text.length).toBeGreaterThan(400);
  });

  it("should cap one event's text at 30,000 characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-"));
    const logFilePath = join(dir, "long.log");
    const minimal = readFileSync(join(FIXTURES, "minimal.log"), "utf8");
    writeFileSync(
      logFilePath,
      minimal.replace("|USER_DEBUG|[1]|DEBUG|", `|USER_DEBUG|[1]|DEBUG|${"x".repeat(40_000)}`),
    );

    try {
      const listed = await searchAt(logFilePath, { type: ["USER_DEBUG"] });
      const asked = await searchAt(logFilePath, {
        eventIndex: listed.events[0]!.eventIndex,
      });

      expect(listed.events[0]!.text).toHaveLength(400);
      expect(asked.events[0]!.text).toHaveLength(30_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should send no text where the event states none but its type", async () => {
    const { events } = await search("governor-heavy", {
      type: ["EXECUTION_STARTED"],
    });

    expect(events[0]!.text).toBe("");
  });

  // Event 287 is an exit line the log lost the entry of: the one record the method ran.
  it("should return an exit line whose entry the log lost", async () => {
    const { events } = await search("governor-heavy", { eventIndex: 287 });

    expect(events.map((row) => row.type)).toEqual(["METHOD_EXIT"]);
  });

  // A folded line (233) or an index past the log reads as an error, not as nothing below it.
  it.each([
    { eventIndex: 10_000 },
    { eventIndex: 233 },
    { parentEventIndex: 10_000 },
  ])("should refuse an index no search reaches: %o", async (args) => {
    await expect(search("governor-heavy", args)).rejects.toThrow(
      `Pass as ${Object.keys(args)[0]} an eventIndex from a row this tool returned.`,
    );
  });

  it("should keep a USER_DEBUG line by the level the code logged it at", async () => {
    const { events } = await search("minimal", { maxLevel: "ERROR", type: ["USER_DEBUG"] });

    // The fixture's line is logged at DEBUG, which an ERROR log does not carry.
    expect(events).toEqual([]);
  });

  // An empty page names no category, so the filter's stands in for it, matched or not.
  it.each([
    { limit: 0, debugCategory: ["database" as const] },
    { debugCategory: ["validation" as const] },
  ])("should give only the filter's levels when no row is returned: %o", async (args) => {
    const { events, capturedAt } = await search("governor-heavy", args);

    expect(events).toEqual([]);
    expect(capturedAt?.map((row) => row.debugCategory)).toEqual(args.debugCategory);
  });

  it("should return an event asked for by id only if it is below parentEventIndex", async () => {
    const inside = await search("governor-heavy", { eventIndex: 10, parentEventIndex: 9 });
    const outside = await search("governor-heavy", { eventIndex: 10, parentEventIndex: 5 });

    expect(inside.events.map((row) => row.eventIndex)).toEqual([10]);
    expect(outside.events).toEqual([]);
  });

  // Top-level rows report the log itself, index 0, as their parent.
  it("should search the whole log below parentEventIndex 0", async () => {
    const all = await search("governor-heavy");
    const below = await search("governor-heavy", { parentEventIndex: 0 });

    expect(below).toEqual(all);
  });

  // Rows that state no category; a type that matched nothing; text, which can sit in any category.
  it.each([
    { type: ["FLOW_CREATE_INTERVIEW_END"] },
    { type: ["SOQL_EXECUTE_BEGIN", "NO_SUCH_TYPE"] },
    { contains: "newInstance(Integer" },
  ])("should give every declared level when the search fixes no category: %o", async (args) => {
    const { capturedAt } = await search("governor-heavy", args);

    expect(capturedAt).toHaveLength(11);
  });

  it("should give the matches' levels when every type named matched", async () => {
    const { capturedAt } = await search("governor-heavy", {
      type: ["SOQL_EXECUTE_BEGIN"],
      limit: 0,
    });

    expect(capturedAt?.map((row) => row.debugCategory)).toEqual(["database"]);
  });

  it("should read contains as text, not as a pattern", async () => {
    const { events } = await search("governor-heavy", {
      contains: "newInstance(Integer",
    });

    expect(events.map((row) => row.eventIndex)).toEqual([6]);
  });
});
