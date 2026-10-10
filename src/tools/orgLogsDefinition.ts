/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What `tools/list` puts on the wire for the org log tools, apart from their
 * handlers, which `src/server.ts` loads lazily. Like
 * `executeAnonymousDefinition.ts`, this must never import a module that loads
 * the Salesforce SDK.
 */

import { z } from "zod";
import { DEFAULT_OUTPUT_DIR } from "./logStore.js";
import {
  DELETE_BATCH_SIZE,
  isApexLogId,
  LOG_SORTS,
} from "../salesforce/apexLogs.js";
import { targetOrgSchema, toolInputSchema } from "./inputSchema.js";

/** Per `apexlog_get_org_logs` call, so one call cannot download for minutes. */
const MAX_LOGS_PER_GET = 25;

/** Rows a list page holds when the caller gives no limit. */
export const DEFAULT_LIMIT = 20;

// Refinements, not `.regex` or `z.iso`, whose patterns cost 89 wire tokens per date-time field.
const logId = z
  .string()
  .refine(isApexLogId, "must be a debug log id, 07L…");

const dateTime = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
    "must be an ISO 8601 date-time with a zone, e.g. 2026-10-09T09:00:00Z",
  );

// One object, so list and delete filter alike and a list call is the delete's dry run.
const logFilters = {
  user: z.string().optional(),
  operation: z.string().optional(),
  request: z.string().optional(),
  succeeded: z.boolean().optional(),
  startTimeFrom: dateTime.optional(),
  startTimeTo: dateTime.optional(),
  minFileSizeBytes: z.number().int().nonnegative().optional(),
};

const listOrgLogsInputSchema = {
  targetOrg: targetOrgSchema,
  ...logFilters,
  // Described here only: delete's description points at these, and each costs tokens on every request.
  user: logFilters.user.describe("Username whose activity was logged"),
  operation: logFilters.operation.describe(
    'Part of the operation, any case, e.g. "aura" for /aura',
  ),
  request: logFilters.request.describe('e.g. "Api" or "Application"'),
  succeeded: logFilters.succeeded.describe("false for failed logs only"),
  startTimeFrom: logFilters.startTimeFrom.describe(
    "ISO 8601 with a zone, e.g. 2026-10-09T09:00:00Z",
  ),
  sortBy: z
    .enum(LOG_SORTS)
    .optional()
    .describe("Newest, slowest or largest first (default: startTime)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(`Page size (default: ${DEFAULT_LIMIT})`),
  cursor: z
    .string()
    .optional()
    .describe("nextCursor from the previous page, with the same filters and sortBy"),
};

export type ListOrgLogsArgs = z.infer<
  z.ZodObject<typeof listOrgLogsInputSchema>
>;

export const listOrgLogsToolConfig = {
  title: "List Org Debug Logs",
  description:
    "List the debug logs stored in a Salesforce org, with how many match. Pass ids to apexlog_get_org_logs to download them.",
  inputSchema: toolInputSchema(listOrgLogsInputSchema),
  annotations: {
    readOnlyHint: true,
  },
};

const getOrgLogsInputSchema = {
  targetOrg: targetOrgSchema,
  ids: z
    .array(logId)
    .min(1)
    .max(MAX_LOGS_PER_GET)
    .optional()
    .describe("Log ids, from apexlog_list_org_logs"),
  latest: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOGS_PER_GET)
    .optional()
    .describe("The newest N logs, in place of ids (default: 1)"),
  outputDir: z
    .string()
    .optional()
    .describe(
      `Directory to save the debug log files (default: ${DEFAULT_OUTPUT_DIR}/ in the first client root)`,
    ),
};

export type GetOrgLogsArgs = z.infer<z.ZodObject<typeof getOrgLogsInputSchema>>;

export const getOrgLogsToolConfig = {
  title: "Get Org Debug Logs",
  description:
    "Download debug logs from a Salesforce org, by id or the newest N, and return each saved file's path, which the analysis tools accept.",
  inputSchema: toolInputSchema(getOrgLogsInputSchema),
  // Writes local files and nothing in the org; not idempotent, because `latest` names newer logs over time.
  annotations: {
    destructiveHint: false,
  },
};

const deleteOrgLogsInputSchema = {
  targetOrg: targetOrgSchema,
  ids: z
    .array(logId)
    .min(1)
    // One delete request's worth.
    .max(DELETE_BATCH_SIZE)
    .optional()
    .describe("Log ids, in place of filters"),
  ...logFilters,
};

export type DeleteOrgLogsArgs = z.infer<
  z.ZodObject<typeof deleteOrgLogsInputSchema>
>;

export const deleteOrgLogsToolConfig = {
  title: "Delete Org Debug Logs",
  description:
    "Delete debug logs from a Salesforce org, by id or by apexlog_list_org_logs's filters, to free its log storage, which blocks trace flags when full. A deleted log cannot be restored.",
  inputSchema: toolInputSchema(deleteOrgLogsInputSchema),
  // Not idempotent: a call by filter deletes the next logs that match.
  annotations: {
    destructiveHint: true,
  },
};
