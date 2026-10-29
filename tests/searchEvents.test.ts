/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadApexLog } from "../src/apexLog";
import {
  searchEventsTool,
  type SearchEventsArgs,
  type SearchEventsResult,
} from "../src/tools/searchEvents";

const FIXTURES = join(__dirname, "eval", "fixtures");

// A value read with `!` that is missing still fails the test, as a TypeError.

async function searchAt(
  logFilePath: string,
  args: SearchEventsArgs = {},
): Promise<SearchEventsResult> {
  return searchEventsTool.run(await loadApexLog(logFilePath), args);
}

function search(
  fixture: string,
  args: SearchEventsArgs = {},
): Promise<SearchEventsResult> {
  return searchAt(join(FIXTURES, `${fixture}.log`), args);
}

// The default page, a search by type and an empty search are pinned by the eval goldens.
describe("searchEvents", () => {
  // The levels come once: a later page reads the same log.
  it("should walk on from nextOffset, with the same matchedCount, and the levels on the first page only", async () => {
    const first = await search("governor-heavy", { limit: 10 });
    const next = await search("governor-heavy", { limit: 10, offset: first.nextOffset! });

    expect(first.nextOffset).toBe(10);
    expect(first.capturedAt).toBeDefined();
    expect(next.capturedAt).toBeUndefined();
    expect(next.matchedCount).toBe(first.matchedCount);
    expect(next.events[0]!.eventIndex).toBeGreaterThan(
      first.events[9]!.eventIndex,
    );
  });

  it("should give no nextOffset on the last page", async () => {
    const { matchedCount } = await search("governor-heavy", { limit: 0 });
    const last = await search("governor-heavy", { offset: matchedCount - 1 });

    expect(last.events).toHaveLength(1);
    expect(last.nextOffset).toBeUndefined();
  });

  // An empty page's nextOffset would equal its offset, so a caller following it would never move.
  it("should give no nextOffset for limit 0", async () => {
    const { matchedCount, nextOffset } = await search("governor-heavy", { limit: 0 });

    expect(matchedCount).toBeGreaterThan(0);
    expect(nextOffset).toBeUndefined();
  });

  // The page budget, not limit, ends this page: nextOffset follows the rows sent.
  it("should give nextOffset after the last row sent when the page budget cuts the page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-"));
    const logFilePath = join(dir, "many.log");
    const minimal = readFileSync(join(FIXTURES, "minimal.log"), "utf8");
    const line = "09:00:00.1 (1731239)|USER_DEBUG|[1]|DEBUG|";
    writeFileSync(
      logFilePath,
      minimal.replace(line, Array.from({ length: 500 }, () => `${line}${"x".repeat(400)}`).join("\n")),
    );

    try {
      const { events, nextOffset, matchedCount } = await searchAt(logFilePath, {
        type: ["USER_DEBUG"],
        limit: 500,
      });

      expect(matchedCount).toBe(500);
      expect(events.length).toBeLessThan(500);
      expect(nextOffset).toBe(events.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should match text ignoring case", async () => {
    const { events } = await search("exceptions", {
      contains: "callOUTexception",
    });

    expect(events).toHaveLength(3);
    expect(events.every((row) => row.type === "EXCEPTION_THROWN")).toBe(true);
  });

  // The parser keeps the failed element out of the message; without it a row cannot say which element failed.
  it("should name the flow element that failed, and find the error by it", async () => {
    const { events } = await search("exceptions", { contains: "Update_Opportunity" });

    expect(events.map((row) => [row.type, row.text])).toEqual([
      [
        "FLOW_ELEMENT_ERROR",
        "This error occurred: FIELD_CUSTOM_VALIDATION_EXCEPTION: Amount is required. FlowRecordUpdate Update_Opportunity",
      ],
    ]);
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

  // The head and tail a long line keeps would hide a match in its middle.
  it("should cut a long line around the contains match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-"));
    const logFilePath = join(dir, "long.log");
    const minimal = readFileSync(join(FIXTURES, "minimal.log"), "utf8");
    writeFileSync(
      logFilePath,
      minimal.replace(
        "|USER_DEBUG|[1]|DEBUG|",
        `|USER_DEBUG|[1]|DEBUG|${"x".repeat(2_000)}OrderId=42${"y".repeat(2_000)}`,
      ),
    );

    try {
      const { events } = await searchAt(logFilePath, { contains: "orderid=42" });

      expect(events[0]!.text).toHaveLength(400);
      expect(events[0]!.text).toContain("OrderId=42");
      expect(events[0]!.text).toMatch(/^…x+OrderId=42y+…$/);
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

  // The log itself (0) or an index past the log reads as an error, not as nothing below it.
  it.each([
    { eventIndex: 10_000 },
    { eventIndex: 0 },
    { parentEventIndex: 10_000 },
  ])("should refuse an index no search reaches: %o", async (args) => {
    await expect(search("governor-heavy", args)).rejects.toThrow(
      `No event in this log has eventIndex ${Object.values(args)[0]}. Pass as ${Object.keys(args)[0]} an eventIndex from a row this tool returned.`,
    );
  });

  it("should return an event asked for by id only if it is below parentEventIndex", async () => {
    const inside = await search("governor-heavy", { eventIndex: 11, parentEventIndex: 10 });
    const outside = await search("governor-heavy", { eventIndex: 11, parentEventIndex: 9 });

    expect(inside.events.map((row) => row.eventIndex)).toEqual([11]);
    expect(outside.events).toEqual([]);
  });

  // Top-level rows report the log itself, index 0, as their parent.
  it("should search the whole log below parentEventIndex 0", async () => {
    const all = await search("governor-heavy");
    const below = await search("governor-heavy", { parentEventIndex: 0 });

    expect(below).toEqual(all);
  });

  // A type that matched nothing; text, which can sit in any category.
  it.each([
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
