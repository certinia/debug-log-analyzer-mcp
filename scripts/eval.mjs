/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Response-quality evaluation for the log analysis tools.
 *
 * Drives the *built* server over real stdio, so what is asserted is the bytes an
 * agent actually receives — TOON encoding included. The jest suite cannot do
 * this: it maps `@toon-format/toon` to a JSON stand-in, so it verifies field
 * shape and nothing about the payload.
 *
 * Four things are checked for every (tool, fixture) pair:
 *
 * 1. Answerability — a realistic user question is only answerable if the fields
 *    it needs are present. Shrinking a response must not cost an answer.
 * 2. No duplication — a figure reported once costs once. No top-level scalar may
 *    be restated in prose.
 * 3. Token budget — a per-case ceiling, so bloat fails instead of creeping.
 * 4. Golden files — the exact payload, committed, so any shape change is a diff
 *    a reviewer can read.
 *
 * Usage:
 *   node scripts/eval.mjs            # assert
 *   node scripts/eval.mjs --update   # rewrite the golden files
 *   node scripts/eval.mjs --report <log>   # token report for one log, no assertions
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "dist", "index.js");
const FIXTURES = path.join(ROOT, "tests", "eval", "fixtures");
const GOLDEN = path.join(ROOT, "tests", "eval", "golden");

/**
 * Questions a user actually asks, and the fields without which the tool cannot
 * answer them.
 */
const ANSWERABILITY = {
  get_apex_log_summary: [
    {
      question: "How many DML statements and SOQL queries were consumed?",
      fields: ["totalDMLOperations", "totalSOQLQueries"],
      limits: ["dmlStatements", "soqlQueries"],
    },
    {
      question: "Are we close to any governor limit?",
      limits: ["cpuTime", "heapSize", "queryRows", "dmlRows"],
    },
    {
      question: "How long did the transaction take, and how much code ran?",
      fields: ["totalExecutionTime", "totalMethods", "size"],
    },
    {
      question: "Is detail missing because a log category was switched off?",
      keys: ["debugLevels"],
    },
    { question: "Did the log parse cleanly?", fields: ["parsingErrors"] },
    { question: "Which namespaces ran?", keys: ["namespaces"] },
  ],
  analyze_apex_log_performance: [
    { question: "Which methods are the slowest?", keys: ["slowestMethods"] },
    {
      question: "What share of the runtime do those methods account for?",
      fields: ["topMethodsSelfPercentage", "totalExecutionTime"],
    },
    { question: "How many methods were considered?", fields: ["totalMethods"] },
    {
      question: "Did any of the slowest methods touch the database?",
      columns: ["dmlCount", "soqlCount", "dmlRows", "soqlRows"],
    },
    {
      question: "Where in the code are they, and whose namespace are they in?",
      columns: ["namespace", "lineNumber"],
    },
  ],
  find_performance_bottlenecks: [
    {
      question: "Is anything over or near a limit, and what should I look at?",
      anyKey: [
        "cpuBottlenecks",
        "databaseBottlenecks",
        "methodBottlenecks",
        "governorLimitWarnings",
        "note",
      ],
    },
  ],
};

/**
 * On `minimal.log` nothing happened, so these must be reported *as zero* rather
 * than left out. "How many DML statements ran?" has to be answerable with "none",
 * and an absent field cannot say that — it cannot be told apart from a log the
 * parser never got a limit block for.
 *
 * `allLimitsZero` asserts the same of every `governorLimits` row that is present,
 * without naming them: the golden file is what pins *which* limits exist, so a
 * new limit needs one edit rather than two.
 */
const MINIMAL_ZEROS = {
  get_apex_log_summary: {
    fields: [
      "totalSOQLQueries",
      "totalDMLOperations",
      "totalSOQLRows",
      "totalDMLRows",
      "parsingErrors",
    ],
    allLimitsZero: true,
  },
};

/** chars/4 ceilings. Generous enough not to be noise, tight enough to catch bloat. */
const TOKEN_BUDGET = {
  "get_apex_log_summary/governor-heavy": 300,
  "get_apex_log_summary/minimal": 240,
  "analyze_apex_log_performance/governor-heavy": 360,
  "analyze_apex_log_performance/minimal": 200,
  "find_performance_bottlenecks/governor-heavy": 160,
  "find_performance_bottlenecks/minimal": 80,
};

const CASES = [
  "get_apex_log_summary",
  "analyze_apex_log_performance",
  "find_performance_bottlenecks",
].flatMap((tool) =>
  ["governor-heavy", "minimal"].map((fixture) => ({ tool, fixture })),
);

/** Minimal MCP stdio client: initialize, then one tools/call per case. */
function createClient() {
  const child = spawn("node", ["--max-old-space-size=8192", SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    async start() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "apex-log-mcp-eval", version: "0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    async callTool(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      const text = response.result?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`${name}: no text content in ${JSON.stringify(response)}`);
      }
      return text;
    },
    stop() {
      child.kill();
    },
  };
}

/**
 * Read the payload's top-level scalars, table headers and rows out of its TOON
 * text. Deliberately shallow — enough to assert what is present and what is
 * repeated, without reimplementing the decoder.
 *
 * It reads the *encoded text* rather than calling `decode` on purpose: the checks
 * are about the encoding, so they need the things decoding throws away — the
 * table header, its column set and its one-line-per-row form.
 */
function inspect(toon) {
  const scalars = new Map();
  const keys = [];
  const columns = new Set();
  const tables = new Map();
  const strings = [];
  let table = new Map();

  for (const line of toon.split("\n")) {
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z][\w]*)(\[\d+\])?(\{([^}]*)\})?:\s*(.*)$/.exec(line);
    if (topLevel) {
      const [, key, , , header, value] = topLevel;
      keys.push(key);
      table = new Map();
      tables.set(key, table);
      if (header) {
        header.split(",").forEach((column) => columns.add(column.trim()));
      } else if (value !== "" && !line.endsWith(":")) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && /^-?[\d.]+$/.test(value)) {
          scalars.set(key, numeric);
        } else {
          // Prose at the top level — a `note`, a `recommendations` list, or a
          // reintroduced `summary`. Scanned for restated figures below.
          strings.push(value);
        }
      }
      continue;
    }
    const indented = line.trim();
    const cells = indented.split(",");
    table.set(cells[0], cells);
    strings.push(indented);
  }

  return { scalars, keys, columns, tables, strings };
}

function checkAnswerability({ tool, fixture }, toon, failures) {
  const { scalars, keys, columns, tables } = inspect(toon);
  const limitRows = tables.get("governorLimits") ?? new Map();

  for (const check of ANSWERABILITY[tool]) {
    const missing = [];
    for (const field of check.fields ?? []) {
      if (!scalars.has(field)) missing.push(field);
    }
    for (const key of check.keys ?? []) {
      if (!keys.includes(key)) missing.push(key);
    }
    for (const column of check.columns ?? []) {
      if (!columns.has(column)) missing.push(column);
    }
    for (const limit of check.limits ?? []) {
      if (!limitRows.has(limit)) missing.push(`governorLimits.${limit}`);
    }
    if (check.anyKey && !check.anyKey.some((key) => keys.includes(key))) {
      missing.push(`one of ${check.anyKey.join(", ")}`);
    }
    if (missing.length) {
      failures.push(
        `${tool}/${fixture}: cannot answer "${check.question}" — missing ${missing.join(", ")}`,
      );
    }
  }

  if (fixture !== "minimal") {
    return;
  }
  const expectZero = MINIMAL_ZEROS[tool];
  if (!expectZero) {
    return;
  }
  for (const field of expectZero.fields ?? []) {
    if (scalars.get(field) !== 0) {
      failures.push(
        `${tool}/${fixture}: ${field} should be reported as 0, got ${scalars.get(field) ?? "nothing"}`,
      );
    }
  }
  if (!expectZero.allLimitsZero) {
    return;
  }
  for (const [limit, cells] of limitRows) {
    if (cells[1] !== "0") {
      failures.push(
        `${tool}/${fixture}: governorLimits.${limit} should be reported with used 0, got ${cells[1]}`,
      );
    }
  }
}

function checkNoDuplication({ tool, fixture }, toon, failures) {
  const { scalars, strings } = inspect(toon);

  // A prose line must not restate a figure that is already a field of its own.
  // This is what the deleted `summary` paragraph did, and what a well-meaning
  // future one would do again.
  for (const [key, value] of scalars) {
    if (value === 0 || value === 1) continue;
    const rendered = String(value);
    const restated = strings.filter(
      (line) => /[A-Za-z]{4}\s/.test(line) && line.includes(rendered),
    );
    if (restated.length) {
      failures.push(
        `${tool}/${fixture}: ${key} (${rendered}) is restated in prose — ${restated[0]}`,
      );
    }
  }
}

function checkTokenBudget({ tool, fixture }, toon, failures) {
  const budget = TOKEN_BUDGET[`${tool}/${fixture}`];
  const tokens = Math.round(toon.length / 4);
  if (budget === undefined) {
    failures.push(`${tool}/${fixture}: no token budget declared`);
  } else if (tokens > budget) {
    failures.push(`${tool}/${fixture}: ~${tokens} tokens exceeds budget of ${budget}`);
  }
  return tokens;
}

async function checkGolden({ tool, fixture }, toon, failures, update) {
  const file = path.join(GOLDEN, `${tool}.${fixture}.expected.txt`);
  if (update) {
    await fs.mkdir(GOLDEN, { recursive: true });
    await fs.writeFile(file, `${toon}\n`, "utf-8");
    return;
  }
  let expected;
  try {
    expected = await fs.readFile(file, "utf-8");
  } catch {
    failures.push(
      `${tool}/${fixture}: no golden file — run \`pnpm run eval:update\` and review the diff`,
    );
    return;
  }
  if (expected.trimEnd() !== toon.trimEnd()) {
    failures.push(
      `${tool}/${fixture}: output differs from ${path.relative(ROOT, file)}. If the change is intended, run \`pnpm run eval:update\`.`,
    );
  }
}

/** One server process for the whole run, stopped however the run ends. */
async function withClient(run) {
  const client = createClient();
  await client.start();
  try {
    return await run(client);
  } finally {
    client.stop();
  }
}

async function report(logFile) {
  await withClient(async (client) => {
    for (const tool of Object.keys(ANSWERABILITY)) {
      const toon = await client.callTool(tool, { logFilePath: logFile });
      console.log(
        `${tool}: ${toon.length} chars, ~${Math.round(toon.length / 4)} tokens`,
      );
      console.log(toon.replace(/^/gm, "  "));
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf("--report");
  if (reportIndex !== -1) {
    const logFile = args[reportIndex + 1];
    if (!logFile) {
      throw new Error("--report needs a path to a log file");
    }
    await report(path.resolve(logFile));
    return;
  }

  const update = args.includes("--update");
  const failures = [];

  await withClient(async (client) => {
    for (const testCase of CASES) {
      const logFilePath = path.join(FIXTURES, `${testCase.fixture}.log`);
      const toon = await client.callTool(testCase.tool, { logFilePath });
      checkAnswerability(testCase, toon, failures);
      checkNoDuplication(testCase, toon, failures);
      const tokens = checkTokenBudget(testCase, toon, failures);
      await checkGolden(testCase, toon, failures, update);
      console.log(
        `${update ? "updated" : "checked"} ${testCase.tool}/${testCase.fixture} — ~${tokens} tokens`,
      );
    }
  });

  if (failures.length) {
    console.error(`\n${failures.length} eval failure(s):`);
    failures.forEach((failure) => console.error(`  ✗ ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log(`\n${CASES.length} eval case(s) passed.`);
}

await main();
