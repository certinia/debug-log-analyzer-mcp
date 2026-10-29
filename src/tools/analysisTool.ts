/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog } from "../apexLog/index.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { loadApexLog } from "../apexLog/index.js";
import { toolInputSchema } from "./inputSchema.js";
import { absolutePathSchema } from "./localFile.js";
import { toonResult } from "./responseShaping.js";

/**
 * The parameter every analysis tool has, first in its schema. Two words of
 * describe: the server `instructions` state the absolute `.log` path once,
 * which is where a fact true of every tool belongs.
 */
const LOG_FILE = { logFilePath: absolutePathSchema.describe("Absolute path") };

/** What a parameter shape parses to. */
export type AnalysisArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

/** An analysis tool: what `tools/list` sends, and the work, apart from the file it reads. */
interface AnalysisTool<S extends z.ZodRawShape, R extends object> {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodObject<typeof LOG_FILE & S, z.core.$strict>;
    annotations: { readOnlyHint: true; openWorldHint: false };
  };
  /** The answer for one parsed log: pure, so a test passes a log and reads the object back. */
  run: (apexLog: ApexLog, args: AnalysisArgs<S>) => R;
  /** What the server registers: load the log, `run`, encode as TOON. */
  handle: (args: AnalysisArgs<typeof LOG_FILE & S>) => Promise<CallToolResult>;
}

/**
 * One analysis tool, stated once: its name, title, description and own parameters.
 * The log file parameter, the annotations, the load and the encoding are the
 * same for every one, so they are added here.
 *
 * Both hints differ from the spec default: an analysis tool reads one local
 * file and changes nothing.
 */
export function defineAnalysisTool<S extends z.ZodRawShape, R extends object>(tool: {
  name: string;
  title: string;
  description: string;
  input: S;
  run: (apexLog: ApexLog, args: AnalysisArgs<S>) => R;
}): AnalysisTool<S, R> {
  const { name, title, description, input, run } = tool;
  return {
    name,
    config: {
      title,
      description,
      inputSchema: toolInputSchema({ ...LOG_FILE, ...input }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run,
    handle: async (args) => {
      // TypeScript cannot see `logFilePath` through a generic schema's inferred type, nor narrow the rest to S.
      const { logFilePath, ...own } = args as { logFilePath: string } & AnalysisArgs<S>;
      return toonResult(run(await loadApexLog(logFilePath), own as AnalysisArgs<S>));
    },
  };
}
