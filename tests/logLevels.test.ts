/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog, DebugLevels } from "@apexdevtools/apex-log-parser";
import {
  capturedAt,
  DEBUG_CATEGORIES,
  declaredLevels,
  DEFAULT_TRACE_CONFIG,
  levelsClause,
  requestedLevels,
  TRACE_CATEGORIES,
} from "../src/logLevels";

/**
 * A log whose header declared these levels. The parser keys them by
 * `DebugLevels` property, which is the spelling every response uses.
 */
const logCapturedAt = (debugLevels: DebugLevels): ApexLog =>
  ({ debugLevels }) as ApexLog;

describe("declaredLevels", () => {
  it("reports every declared level, in the order a header states them", () => {
    expect(
      declaredLevels(
        logCapturedAt({ database: "FINEST", apexCode: "ERROR", wave: "INFO" }),
      ),
    ).toEqual([
      { debugCategory: "apexCode", level: "ERROR" },
      { debugCategory: "database", level: "FINEST" },
      { debugCategory: "wave", level: "INFO" },
    ]);
  });

  it("leaves out a category the header never declared, rather than naming a default", () => {
    expect(declaredLevels(logCapturedAt({ database: "FINEST" }))).toEqual([
      { debugCategory: "database", level: "FINEST" },
    ]);
  });

  it("names every category the parser can declare a level for", () => {
    const everyCategory = Object.fromEntries(
      DEBUG_CATEGORIES.map((category) => [category, "FINEST"]),
    ) as DebugLevels;

    expect(declaredLevels(logCapturedAt(everyCategory))).toHaveLength(
      DEBUG_CATEGORIES.length,
    );
  });
});

describe("capturedAt", () => {
  it("reports the level of each category the caller names", () => {
    expect(
      capturedAt(
        logCapturedAt({
          apexCode: "ERROR",
          system: "FINE",
          database: "FINEST",
        }),
        ["database", "apexCode"],
      ),
    ).toEqual([
      { debugCategory: "apexCode", level: "ERROR" },
      { debugCategory: "database", level: "FINEST" },
    ]);
  });

  it("leaves out a named category the header never declared", () => {
    expect(
      capturedAt(logCapturedAt({ database: "FINEST" }), [
        "database",
        "visualforce",
      ]),
    ).toEqual([{ debugCategory: "database", level: "FINEST" }]);
  });

  it("leaves out a declared category the caller did not name", () => {
    expect(
      capturedAt(logCapturedAt({ apexProfiling: "FINEST" }), ["database"]),
    ).toEqual([]);
  });
});

describe("requestedLevels", () => {
  it("should set every category to a bare level", () => {
    const levels = requestedLevels("FINEST");

    TRACE_CATEGORIES.forEach((category) => expect(levels[category]).toBe("FINEST"));
  });
});

describe("levelsClause", () => {
  it("should group the categories by level, in category order", () => {
    expect(levelsClause(DEFAULT_TRACE_CONFIG)).toBe(
      "apexCode, apexProfiling, visualforce, workflow FINE; callout, system, validation DEBUG; database FINEST; nba, wave INFO",
    );
  });
});
