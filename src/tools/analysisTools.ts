/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { listSlowOperationsTool } from "./listSlowOperations.js";
import { getLogSummaryTool } from "./getLogSummary.js";
import { listLimitRisksTool } from "./listLimitRisks.js";
import { searchEventsTool } from "./searchEvents.js";

/** Every analysis tool, in the order `tools/list` sends them. */
export const analysisTools = [
  listSlowOperationsTool,
  getLogSummaryTool,
  listLimitRisksTool,
  searchEventsTool,
];
