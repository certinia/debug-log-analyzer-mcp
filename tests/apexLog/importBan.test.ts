/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { execFileSync } from "child_process";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");

const PARSER_IMPORT =
  'import { parse } from "@apexdevtools/apex-log-parser";\nexport const read = parse;\n';

/**
 * Lints the parser import as if it sat at each path, in one ESLint process.
 * A child process, because the config is ESM and jest compiles to CommonJS.
 */
function bannedAt(files: string[]): Record<string, boolean> {
  const script = `
    const { ESLint } = require("eslint");
    (async () => {
      const eslint = new ESLint();
      const banned = {};
      for (const filePath of ${JSON.stringify(files)}) {
        const [result] = await eslint.lintText(${JSON.stringify(PARSER_IMPORT)}, { filePath });
        banned[filePath] = result.messages.some(
          (message) => message.ruleId === "@typescript-eslint/no-restricted-imports",
        );
      }
      process.stdout.write(JSON.stringify(banned));
    })();
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf-8" }));
}

// A parser import anywhere else would spread the next parser change past the seam again.
describe("the parser import ban", () => {
  it("refuses the parser outside src/apexLog/, and allows it inside", () => {
    expect(
      bannedAt([
        "src/tools/probe.ts",
        "src/probe.ts",
        "src/salesforce/probe.ts",
        "tests/probe.test.ts",
        "src/apexLog/probe.ts",
        "tests/apexLog/probe.test.ts",
        "tests/parserContract.test.ts",
      ]),
    ).toEqual({
      "src/tools/probe.ts": true,
      "src/probe.ts": true,
      "src/salesforce/probe.ts": true,
      "tests/probe.test.ts": true,
      "src/apexLog/probe.ts": false,
      "tests/apexLog/probe.test.ts": false,
      "tests/parserContract.test.ts": false,
    });
  }, 30_000);
});
