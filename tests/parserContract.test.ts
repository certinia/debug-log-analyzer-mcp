/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What this server assumes about `@apexdevtools/apex-log-parser`.
 *
 * Every other suite works on hand-built events, so none of them would notice a
 * parser upgrade that changed one of these. Each case here is an assumption a
 * tool would silently misreport without, pinned against a real parse.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_NAMESPACE,
  eventType,
  LEVEL,
  LIMIT_METRICS,
  parse,
} from "@apexdevtools/apex-log-parser";
import type { ApexEvent } from "@apexdevtools/apex-log-parser";

const FIXTURES = join(__dirname, "eval", "fixtures");

const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.log`), "utf-8");

const HEADER =
  "64.0 APEX_CODE,FINE;APEX_PROFILING,FINE;CALLOUT,NONE;DATA_ACCESS,NONE;DB,INFO;NBA,NONE;SYSTEM,NONE;VALIDATION,NONE;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,NONE";

/** The fixtures with a transaction in them, so a per-event sweep has events. */
const TIMED_FIXTURES = ["governor-heavy", "minimal", "heap-heavy"];

/** Every event the tree holds. */
function tree(node: { children: readonly ApexEvent[] }, into: ApexEvent[] = []): ApexEvent[] {
  for (const child of node.children) {
    into.push(child);
    tree(child, into);
  }
  return into;
}

/** A log of `lines` inside one transaction, closed, so it raises no issue of its own. */
const transaction = (...lines: string[]): string =>
  [
    HEADER,
    "09:00:00.1 (1000)|EXECUTION_STARTED",
    ...lines,
    "09:00:01.0 (10000)|EXECUTION_FINISHED",
    "",
  ].join("\n");

describe("parser contract", () => {
  describe("ApexLog.size", () => {
    const log = transaction("09:00:00.1 (2000)|USER_DEBUG|[1]|DEBUG|£100 naïve 🙂");

    // `apexlog_get_summary` publishes it as `fileSizeBytes`, so a log that is
    // not ASCII must not under-read. The code-unit length is asserted beside it
    // because that is what makes the reading unambiguous: the two disagree only
    // where the count is in bytes - apex-dev-tools/apex-log-parser#70.
    it("counts UTF-8 bytes, not UTF-16 code units", async () => {
      const { size } = await parse(log);

      expect(size).toBe(Buffer.byteLength(log, "utf8"));
      expect(size).toBeGreaterThan(log.length);
    });
  });

  describe("ApexLog.debugLevels", () => {
    // `apexlog_execute_anonymous.levelsOverridden` compares these with the
    // levels it asked for, by the `DebugCategory` key and not the header token.
    it("reads the header's levels under the DebugCategory keys", async () => {
      const { debugLevels } = await parse(
        [HEADER, "09:00:00.1 (1000)|EXECUTION_STARTED", ""].join("\n"),
      );

      expect(debugLevels).toMatchObject({
        apexCode: "FINE",
        database: "INFO",
        dataAccess: "NONE",
      });
    });
  });

  describe("ApexLog.duration", () => {
    const log = [
      HEADER,
      "09:00:00.0 (500)|USER_INFO|[EXTERNAL]|005000000000001|user@example.com|(GMT+00:00) Greenwich Mean Time (GMT)|GMT+00:00",
      "09:00:00.1 (1000)|EXECUTION_STARTED",
      "09:00:00.1 (10000)|EXECUTION_FINISHED",
      "",
    ].join("\n");

    // Every tool publishes it as `durationTotalMs` and divides each
    // `selfPercentage` by it. The log starts at `USER_INFO`, not at
    // `EXECUTION_STARTED`, so the header gap is in the total and in no
    // category, and the category rows need not sum to 100.
    it("runs from USER_INFO, not from EXECUTION_STARTED", async () => {
      expect((await parse(log)).duration.total).toBe(9500);
    });

    // `apexlog_get_summary` reads frame self time off the log's children
    // alone. A frame nested deeper would file its time as unattributed.
    it.each(TIMED_FIXTURES)(
      "puts every EXECUTION_STARTED at the top of the log (%s)",
      async (name) => {
        const frames = tree(await parse(fixture(name))).filter(
          (event) => event.type === "EXECUTION_STARTED",
        );

        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((frame) => frame.parent === null)).toBe(true);
      },
    );
  });

  describe("limits.peak.heapSize", () => {
    // Heap is a level and not a counter, so the transaction peak is the highest
    // figure any namespace reported and never the sum of them. Summing would
    // report 300000 here, half again over what the platform measured.
    const namespaceBlock = (namespace: string, heap: number): string =>
      [
        `09:00:00.9 (9000)|LIMIT_USAGE_FOR_NS|${namespace}|`,
        "  Number of SOQL queries: 0 out of 100",
        `  Maximum heap size: ${heap} out of 6000000`,
        "",
      ].join("\n");

    const log = transaction(
      "09:00:00.9 (9000)|CUMULATIVE_LIMIT_USAGE",
      namespaceBlock("(default)", 200000),
      namespaceBlock("core_pkg", 100000),
      "09:00:00.9 (9000)|CUMULATIVE_LIMIT_USAGE_END",
    );

    it("reports the highest namespace figure, not their sum", async () => {
      expect((await parse(log)).limits.peak.heapSize.used).toBe(200000);
    });
  });

  describe("heap measures", () => {
    // Allocations chosen so that no two heap figures agree: the pair that is
    // freed again leaves the net at 500_000, every allocation counted gives a
    // gross of 950_000, the highest the run ever held is 750_000, and the
    // limit block states nothing.
    const log = transaction(
      "09:00:00.2 (2000)|HEAP_ALLOCATE|[1]|Bytes:100000",
      "09:00:00.2 (3000)|HEAP_ALLOCATE|[2]|Bytes:-100000",
      "09:00:00.3 (4000)|HEAP_ALLOCATE|[1]|Bytes:100000",
      "09:00:00.3 (5000)|HEAP_ALLOCATE|[2]|Bytes:-100000",
      "09:00:00.4 (6000)|HEAP_ALLOCATE|[3]|Bytes:250000",
      "09:00:00.5 (7000)|BULK_HEAP_ALLOCATE|Bytes:250000",
      "09:00:00.6 (8000)|HEAP_ALLOCATE|[4]|Bytes:250000",
      "09:00:00.7 (9000)|HEAP_ALLOCATE|[5]|Bytes:-250000",
      "09:00:00.9 (9500)|CUMULATIVE_LIMIT_USAGE",
      "09:00:00.9 (9500)|LIMIT_USAGE_FOR_NS|(default)|",
      "  Maximum heap size: 0 out of 6000000",
      "",
      "09:00:00.9 (9500)|CUMULATIVE_LIMIT_USAGE_END",
    );

    // `apexlog_get_summary` publishes `peak.heapSize` as its `heapSize` row.
    // Nothing else in the log agrees with it: the block states zero and so does
    // `final`, the net frees back to 500_000, and the gross counts every
    // allocation at 950_000. 250_000 of the peak arrives as one
    // `BULK_HEAP_ALLOCATE`, so a parser counting only `HEAP_ALLOCATE` also
    // reaches 500_000.
    //
    // The block is read through `snapshots` and not `final`, which is zero
    // either way: a parser that stopped reading `LIMIT_USAGE_FOR_NS` has no
    // snapshot, and only this spelling fails on that.
    it("reports heap as the events' peak, not the block, net or gross", async () => {
      const { limits, heapAllocated, heapGross } = await parse(log);
      const [snapshot] = limits.snapshots;

      expect(snapshot?.limits.heapSize.used).toBe(0);
      expect(limits.final.heapSize.used).toBe(0);
      expect(heapAllocated?.total).toBe(500_000);
      expect(heapGross?.total).toBe(950_000);
      expect(limits.peak.heapSize.used).toBe(750_000);
    });

    const nested = transaction(
      "09:00:00.1 (2000)|METHOD_ENTRY|[1]|01p000000000000|Outer.run()",
      "09:00:00.2 (3000)|HEAP_ALLOCATE|[2]|Bytes:100",
      "09:00:00.3 (4000)|METHOD_ENTRY|[3]|01p000000000001|Inner.run()",
      "09:00:00.4 (5000)|HEAP_ALLOCATE|[4]|Bytes:900",
      "09:00:00.5 (6000)|METHOD_EXIT|[3]|Inner.run()",
      "09:00:00.6 (7000)|METHOD_EXIT|[1]|Outer.run()",
    );

    // What `groupOperations` sums `heapSelfNetBytes` plainly on: an allocation
    // lands in its direct parent's `self` and in no other event's, so adding the
    // members of a group counts each allocation once even where one member ran
    // inside another. Every other suite builds its own events, so a parser that
    // folded a subtree net into `self` would leave jest green and every grouped
    // row silently doubled.
    //
    // The totals are asserted beside the selfs because they are what makes the
    // reading unambiguous: 1,000 against 100 is the parent counting the child's
    // allocation in one figure and not the other.
    it("keeps a method's heap self to its own body, so a group can sum it", async () => {
      const methods = (await parse(nested)).ofType("METHOD_ENTRY");

      expect(
        methods.map(({ text, heapAllocated }) => [
          text,
          heapAllocated?.self,
          heapAllocated?.total,
        ]),
      ).toEqual([
        ["Outer.run()", 100, 1000],
        ["Inner.run()", 900, 900],
      ]);
    });

    const freed = transaction(
      "09:00:00.1 (2000)|METHOD_ENTRY|[1]|01p000000000000|Outer.run()",
      "09:00:00.2 (3000)|HEAP_ALLOCATE|[2]|Bytes:1000",
      "09:00:00.3 (4000)|HEAP_DEALLOCATE|[3]|Bytes:400",
      "09:00:00.6 (7000)|METHOD_EXIT|[1]|Outer.run()",
    );

    // `heapSelfNetBytes` is a net, so a body that frees what it took must read
    // below what it allocated. The gross is asserted beside it because that is
    // what makes the net unambiguous: 600 against 1,000 is the free applied to
    // one figure and not the other - apex-dev-tools/apex-log-parser#73.
    it("nets HEAP_DEALLOCATE off the body that allocated", async () => {
      const parsed = await parse(freed);
      const [method] = parsed.ofType("METHOD_ENTRY");

      expect(parsed.heapAllocated?.total).toBe(600);
      expect(parsed.heapGross?.total).toBe(1000);
      expect(method?.heapAllocated?.self).toBe(600);
    });

    // `Operation.heapSelfNetBytes` says an allocation inside a package window
    // lands in the calling method's own body: the package frame holds no events.
    it("gives ENTERING_MANAGED_PKG no children, so its heap lands on the caller", async () => {
      const parsed = await parse(
        transaction(
          "09:00:00.1 (2000)|METHOD_ENTRY|[1]|01p000000000000|Outer.run()",
          "09:00:00.2 (3000)|ENTERING_MANAGED_PKG|core_pkg",
          "09:00:00.3 (4000)|HEAP_ALLOCATE|[EXTERNAL]|Bytes:500",
          "09:00:00.6 (7000)|METHOD_EXIT|[1]|Outer.run()",
        ),
      );
      const [pkg] = parsed.ofType("ENTERING_MANAGED_PKG");
      const [method] = parsed.ofType("METHOD_ENTRY");

      expect(pkg?.children).toEqual([]);
      expect(method?.heapAllocated?.self).toBe(500);
    });
  });

  describe("ApexEvent.isFrame and ApexEvent.debugCategory", () => {
    // `isRankable` in tools/operations.ts ranks frames, so a timed event that
    // is not one would be ranked nowhere and its time reported nowhere. Every
    // response then states `debugCategory`: a ranked row's category, a
    // `categories` row in the summary, and a `capturedAt` level.
    it.each(TIMED_FIXTURES)(
      "makes every event that carries a duration a frame, with a category (%s)",
      async (name) => {
        const events = tree(await parse(fixture(name)));
        const timed = events.filter((event) => event.duration.total > 0);

        expect(timed.length).toBeGreaterThan(0);
        expect(timed.filter((event) => !event.isFrame)).toEqual([]);
        expect(events.filter((event) => !event.debugCategory)).toEqual([]);
      },
    );

    // What lets the group key carry the type alone: keying on it keeps the
    // category column true of every member of a group. One type stamped with
    // two categories would make that false, and a folded row would state the
    // first member's category for all of them.
    it.each(TIMED_FIXTURES)(
      "is one category per event type (%s)",
      async (name) => {
        const byType = new Map<string, Set<string>>();
        tree(await parse(fixture(name))).forEach(({ type, debugCategory }) =>
          byType.set(type, (byType.get(type) ?? new Set()).add(debugCategory)),
        );

        expect(byType.size).toBeGreaterThan(0);
        expect(
          [...byType]
            .filter(([, categories]) => categories.size > 1)
            .map(([type]) => type),
        ).toEqual([]);
      },
    );

    // The category that decides whether the line reached the log, not the code
    // it ran in: a Visualforce call is `visualforce`, a limit block `apexProfiling`.
    it("names the category that gates the line", async () => {
      const log = await parse(
        transaction(
          "09:00:00.2 (2000)|VF_APEX_CALL_START|[1]|Controller invoke(save)",
          "09:00:00.3 (3000)|VF_APEX_CALL_END|Controller invoke(save)",
          "09:00:00.4 (4000)|CUMULATIVE_LIMIT_USAGE",
          "09:00:00.4 (4000)|CUMULATIVE_LIMIT_USAGE_END",
        ),
      );
      const categoryOf = (type: string) =>
        tree(log).find((event) => event.type === type)?.debugCategory;

      expect(categoryOf("VF_APEX_CALL_START")).toBe("visualforce");
      expect(categoryOf("CUMULATIVE_LIMIT_USAGE")).toBe("apexProfiling");
    });

    // `apexlog_list_limit_risks` reports these two levels and no others,
    // because they are the ones that decide whether a limit figure was written
    // at all: every limit but heap comes from the cumulative blocks, and heap
    // from `HEAP_ALLOCATE`.
    it("gates the limit figures under apexProfiling, and heap under apexCode", async () => {
      const log = await parse(
        transaction(
          "09:00:00.2 (2000)|HEAP_ALLOCATE|[1]|Bytes:100",
          "09:00:00.9 (9000)|CUMULATIVE_LIMIT_USAGE",
          "09:00:00.9 (9000)|LIMIT_USAGE_FOR_NS|(default)|",
          "  Number of SOQL queries: 1 out of 100",
          "",
          "09:00:00.9 (9000)|CUMULATIVE_LIMIT_USAGE_END",
        ),
      );
      const categoryOf = (type: string) =>
        tree(log).find((event) => event.type === type)?.debugCategory;

      expect(categoryOf("CUMULATIVE_LIMIT_USAGE")).toBe("apexProfiling");
      expect(categoryOf("LIMIT_USAGE_FOR_NS")).toBe("apexProfiling");
      expect(categoryOf("HEAP_ALLOCATE")).toBe("apexCode");
    });
  });

  describe("ApexEvent.namespace and ApexLog.namespaces", () => {
    const log = transaction(
      "09:00:00.1 (2000)|CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001|c2g.Svc.run()",
      "09:00:00.1 (3000)|METHOD_ENTRY|[1]|01p000000000001|c2g.Svc.save()",
      "09:00:00.1 (4000)|SOQL_EXECUTE_BEGIN|[2]|Aggregations:0|SELECT Id FROM Account",
      "09:00:00.1 (5000)|SOQL_EXECUTE_END|[2]|Rows:1",
      "09:00:00.1 (6000)|DML_BEGIN|[3]|Op:Insert|Type:Account|Rows:1",
      "09:00:00.1 (7000)|DML_END|[3]",
      "09:00:00.1 (8000)|METHOD_EXIT|[1]|01p000000000001|c2g.Svc.save()",
      "09:00:00.1 (9000)|CODE_UNIT_FINISHED|c2g.Svc.run()",
    );

    // The tools read an event's own namespace and never its parent's. Both halves
    // are the parser's: a query states no namespace and takes its method's, while
    // DML is in `default` however it was reached - which is why `callerNamespace` exists.
    it("copies a namespace down to a query, and leaves DML in default", async () => {
      const parsed = await parse(log);
      const namespaceOf = (type: string) => tree(parsed).find((event) => event.type === type)?.namespace;

      expect(namespaceOf("SOQL_EXECUTE_BEGIN")).toBe("c2g");
      expect(namespaceOf("DML_BEGIN")).toBe(DEFAULT_NAMESPACE);
    });

    // `apexlog_get_summary.namespaces` is this list as it is.
    it("lists default among the namespaces, in the order each first appears", async () => {
      expect((await parse(log)).namespaces).toEqual([DEFAULT_NAMESPACE, "c2g"]);
    });
  });

  describe("issues and thrownCount", () => {
    // `apexlog_get_summary.fatalErrors` reads both halves: the message names the
    // failure and the stack names the code. Both come off one issue.
    it("states a fatal's message as the summary and its stack as the description", async () => {
      const { issues } = await parse(
        transaction(
          "09:00:00.1 (4000)|FATAL_ERROR|System.LimitException: Apex CPU time limit exceeded",
          "Class.Searcher.search: line 31, column 1",
          "Class.Service.run: line 102, column 1",
        ),
      );

      expect(issues).toMatchObject([
        {
          type: "fatal",
          summary: "System.LimitException: Apex CPU time limit exceeded",
          description:
            "Class.Searcher.search: line 31, column 1\nClass.Service.run: line 102, column 1",
        },
      ]);
    });

    // This is what makes `fatalErrors` safe to report as a table: one real log
    // throws 4,501 times for three messages. `exceptions` holds every
    // occurrence, so a tool reading that would return thousands of rows.
    it("holds one issue per distinct failure while exceptions holds every one", async () => {
      // On `fatal`, which is the type the summary reads. An `EXCEPTION_THROWN`
      // raises an issue only when its message names a `System.LimitException`,
      // so deduping that type would exercise a path no tool looks at.
      const fatal = "|FATAL_ERROR|System.LimitException: Apex CPU time limit exceeded";
      const log = await parse(
        transaction(`09:00:00.1 (2000)${fatal}`, `09:00:00.1 (3000)${fatal}`),
      );

      expect(log.issues.filter((issue) => issue.type === "fatal")).toHaveLength(1);
      expect(log.exceptions).toHaveLength(2);
    });

    // `thrownCount` is the magnitude the summary reports beside `fatalErrors`,
    // so it must not double-count the fatal that the table already names.
    it("counts a thrown exception and not the fatal error", async () => {
      const log = await parse(
        transaction(
          "09:00:00.1 (2000)|EXCEPTION_THROWN|[12]|System.DmlException: Update failed",
          "09:00:00.1 (4000)|FATAL_ERROR|System.DmlException: Update failed",
        ),
      );

      expect(log.exceptions.map((event) => event.type)).toEqual([
        "EXCEPTION_THROWN",
        "FATAL_ERROR",
      ]);
      expect(log.thrownCount?.total).toBe(1);
    });

    // `apexlog_get_summary.exceptions` names a throw's frame by walking up from it.
    it("parents a throw under the method it ran in, and reads its line as a number", async () => {
      const throws = (await parse(fixture("exceptions"))).ofType("EXCEPTION_THROWN");

      expect(
        throws.map(({ parent, lineNumber }) => [
          parent?.type,
          parent?.text,
          lineNumber,
        ]),
      ).toEqual([
        ["METHOD_ENTRY", "SyncService.fetch(Integer)", 31],
        ["METHOD_ENTRY", "SyncService.fetch(Integer)", 31],
        ["METHOD_ENTRY", "SyncService.fetch(Integer)", 31],
        ["METHOD_ENTRY", "SyncService.save()", 44],
      ]);
    });

    // `multipleLogsWarning` finds this by its summary and reads the count from its description.
    it("raises Multiple-Logs, with the count, for a file that holds more than one log", async () => {
      const { issues } = await parse(transaction() + transaction() + transaction());

      expect(issues).toMatchObject([
        { summary: "Multiple-Logs", description: expect.stringContaining("3 logs") },
      ]);
    });

    // A managed package states a hidden line as `EXTERNAL`, which the summary passes on.
    it("reads a hidden line as EXTERNAL", async () => {
      const log = await parse(
        transaction(
          "09:00:00.1 (2000)|EXCEPTION_THROWN|[EXTERNAL]|pkg.ApiException: denied",
        ),
      );

      expect(log.exceptions[0]?.lineNumber).toBe("EXTERNAL");
    });
  });

  describe("ApexLog.events and ApexLog.event", () => {
    // `apexlog_get_summary.flowErrorCount` counts these by type, not by a walk.
    it("indexes every event in the tree by type, flow element errors included", async () => {
      const log = await parse(fixture("exceptions"));

      expect(log.ofType("FLOW_ELEMENT_ERROR")).toHaveLength(1);
      expect(tree(log).filter((event) => event.type === "FLOW_ELEMENT_ERROR")).toHaveLength(1);
    });

    // `apexlog_search_events` resolves `eventId` with `event` and pages in
    // tree order, so the tree must read in id order from 1, and an id must
    // name its own event.
    it.each(TIMED_FIXTURES)(
      "numbers the events from 1 in log order, and finds each by its id, in %s",
      async (name) => {
        const log = await parse(fixture(name));
        const ids = tree(log).map((event) => event.id);

        expect(ids).toEqual(ids.map((_, index) => index + 1));
        expect(ids.every((id) => log.event(id)?.id === id)).toBe(true);
        expect(log.event(0)).toBeNull();
      },
    );
  });

  // `apexlog_list_slow_operations`, `apexlog_get_summary` and
  // `apexlog_search_events` read the columns, not the events, so a column that
  // drifted from its event would change a response with no error.
  describe("ApexLog.columns", () => {
    const COUNTS = [
      "soqlCount",
      "dmlCount",
      "soslCount",
      "soqlRowCount",
      "dmlRowCount",
      "soslRowCount",
      "thrownCount",
    ] as const;

    it.each([...TIMED_FIXTURES, "exceptions"])(
      "states what each event states, in %s",
      async (name) => {
        const log = await parse(fixture(name));
        const { columns } = log;
        const events = tree(log);

        expect(columns.count).toBe(events.length);
        for (const event of events) {
          const { id } = event;
          const info = eventType(columns.type[id] ?? -1);
          expect({
            type: info?.type,
            debugCategory: info?.debugCategory,
            parent: columns.parent[id],
            below: (columns.subtreeEnd[id] ?? 0) - id - 1,
            isFrame: columns.isFrame[id] === 1,
            durationSelf: columns.durationSelf[id],
            durationTotal: columns.durationTotal[id],
            namespace: columns.namespace.at(id),
            text: columns.text.at(id),
            heapSelf: columns.heapAllocated?.self[id] ?? 0,
            counts: COUNTS.map((count) => columns[count]?.total[id] ?? 0),
          }).toEqual({
            type: event.type,
            debugCategory: event.debugCategory,
            parent: event.parent?.id ?? 0,
            below: tree(event).length,
            isFrame: event.isFrame,
            durationSelf: event.duration.self,
            durationTotal: event.duration.total,
            namespace: event.namespace,
            text: event.text,
            heapSelf: event.heapAllocated?.self ?? 0,
            counts: COUNTS.map((count) => event[count]?.total ?? 0),
          });
        }
      },
    );
  });

  describe("SOQL_EXECUTE_BEGIN details", () => {
    // `planOf` reads the plan off the query, not off its explain child; the
    // two must be the same plan.
    it("carries the plan of its SOQL_EXECUTE_EXPLAIN child", async () => {
      const log = await parse(fixture("governor-heavy"));
      const explained = log
        .ofType("SOQL_EXECUTE_BEGIN")
        .filter((query) => query.details.explain !== null);
      const [query] = explained;
      const child = query?.children.find(({ type }) => type === "SOQL_EXECUTE_EXPLAIN");

      expect(explained).toHaveLength(1);
      expect(query?.details.explain).toEqual(child?.details);
      expect(query?.details.explain).toMatchObject({
        leadingOperationType: "TableScan",
        relativeCost: 0.65,
        cardinality: 1,
        sObjectCardinality: 1,
      });
    });
  });

  describe("ApexLog.isTruncated and ApexLog.unclosedFrames", () => {
    // `apexlog_get_summary.truncated` is this flag, and the figures beside it
    // are floors when it is set. It follows the regions the platform said it
    // dropped, so a log that merely ends mid-frame does not raise it.
    it("is set by a region the platform dropped, not by an unclosed frame", async () => {
      const dropped = await parse(fixture("truncated"));

      expect(dropped.truncation.regions.map((region) => region.kind)).toEqual([
        "skipped-lines",
        "max-size",
      ]);
      expect(dropped.truncation.totalSkippedBytes).toBe(14_680_064);
      expect(dropped.isTruncated).toBe(true);

      const unclosed = await parse(
        [
          HEADER,
          "09:00:00.1 (1000)|EXECUTION_STARTED",
          "09:00:00.1 (2000)|METHOD_ENTRY|[1]|01pEa00000Never|Never.returns()",
          "",
        ].join("\n"),
      );

      expect(unclosed.unclosedFrames.map(({ endedBy }) => endedBy)).toContain("log-end");
      expect(unclosed.truncation.regions).toEqual([]);
      expect(unclosed.isTruncated).toBe(false);
    });

    // `apexlog_get_summary.truncated` counts `log-end` alone: a frame an
    // exception unwound is closed by a later exit line, and the log goes on.
    it("ends a frame an exception unwound by `unwind`, not by `log-end`", async () => {
      const log = await parse(
        transaction(
          "09:00:00.1 (2000)|METHOD_ENTRY|[1]|01p000000000000|Outer.run()",
          "09:00:00.1 (3000)|METHOD_ENTRY|[2]|01p000000000001|Inner.run()",
          "09:00:00.1 (4000)|EXCEPTION_THROWN|[3]|System.NullPointerException: x",
          "09:00:00.1 (5000)|METHOD_EXIT|[1]|Outer.run()",
        ),
      );

      expect(log.unclosedFrames.map(({ text, endedBy }) => [text, endedBy])).toEqual([
        ["Inner.run()", "unwind"],
      ]);
    });
  });

  describe("LIMIT_METRICS", () => {
    // Every tool reports these thirteen as a fixed table, and the suites that
    // check them derive their expectations from this list, so it is pinned once
    // here - including the order, which the tables are emitted in.
    it("states the thirteen governor metrics, in report order", () => {
      expect(Object.keys(LIMIT_METRICS)).toEqual([
        "soqlQueries",
        "soslQueries",
        "queryRows",
        "dmlStatements",
        "publishImmediateDml",
        "dmlRows",
        "cpuTime",
        "heapSize",
        "callouts",
        "emailInvocations",
        "futureCalls",
        "queueableJobsAddedToQueue",
        "mobileApexPushCalls",
      ]);
    });
  });

  describe("LEVEL", () => {
    // The `debugLevel` parameter's enum is built from these, so a renamed or
    // dropped level would change the tool's public schema.
    it("states the eight levels a trace flag accepts", () => {
      expect(Object.values(LEVEL)).toEqual([
        "NONE",
        "ERROR",
        "WARN",
        "INFO",
        "DEBUG",
        "FINE",
        "FINER",
        "FINEST",
      ]);
    });
  });
});
