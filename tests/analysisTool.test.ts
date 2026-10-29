/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { join } from "path";
import { z } from "zod";
import { decode } from "@toon-format/toon";
import type { ApexLog } from "../src/apexLog";

import { defineAnalysisTool } from "../src/tools/analysisTool";
import { analysisTools } from "../src/tools/analysisTools";

const MINIMAL_LOG = join(__dirname, "eval", "fixtures", "minimal.log");

/** A tool whose answer says what it was handed, so the shell around `run` can be read back. */
const echoTool = defineAnalysisTool({
  name: "echo",
  title: "Echo",
  description: "Echo",
  input: { limit: z.number().optional() },
  run: (apexLog: ApexLog, args) => ({ args, parsed: apexLog.children.length > 0 }),
});

describe("defineAnalysisTool", () => {
  // Pinned here for all four, since the shared definition sets them: a token
  // budget with headroom would not notice one coming back.
  it.each(analysisTools)(
    "annotates $name as reading one local file and changing nothing",
    (tool) => {
      expect(tool.config.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    },
  );

  it("puts logFilePath first, required, before the tool's own parameters", () => {
    const { shape } = echoTool.config.inputSchema;

    expect(Object.keys(shape)).toEqual(["logFilePath", "limit"]);
    expect(echoTool.config.inputSchema.safeParse({ limit: 1 }).success).toBe(false);
  });

  it.each(["./run.log", ""])(
    "refuses logFilePath %p rather than resolving it against our cwd",
    (logFilePath) => {
      const result = echoTool.config.inputSchema.safeParse({ logFilePath });

      expect(result.error?.issues[0]?.message).toBe("must be an absolute path");
    },
  );

  it("parses the log at logFilePath and hands run the rest, as one TOON block", async () => {
    const result = await echoTool.handle({ logFilePath: MINIMAL_LOG, limit: 3 });

    // The path is the caller's own, so repeating it back would only cost tokens.
    expect(result.content).toHaveLength(1);
    expect(decode((result.content[0] as { text: string }).text)).toEqual({
      args: { limit: 3 },
      parsed: true,
    });
  });

  // A throw, not a result: the SDK turns it into the tool error. The wording is src/apexLog/source.ts's.
  it("throws, naming the path, when the log cannot be read", async () => {
    await expect(
      echoTool.handle({ logFilePath: "/nonexistent/file.log" }),
    ).rejects.toThrow("/nonexistent/file.log");
  });
});
