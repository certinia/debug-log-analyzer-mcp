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
 * Three more are checked once per run:
 *
 * 5. Definition budget — what `tools/list` costs on every request, per tool and
 *    in total, measured over the whole wire object the client receives.
 * 6. Selection keywords — the words a client's tool search matches on, so a
 *    trim that saves tokens cannot quietly cost discovery.
 * 7. README tables — the published figures are generated from this run, so a
 *    change that moves them fails until the README is regenerated with it.
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
const README = path.join(ROOT, "README.md");

/** The context window the published share is a share of. */
const CONTEXT_WINDOW = 200_000;

/** Every token figure in this file, and in the README, comes from here. */
const estimateTokens = (text) => Math.round(text.length / 4);

/**
 * Questions a user actually asks, and the fields without which the tool cannot
 * answer them.
 */
const ANSWERABILITY = {
  apexlog_get_summary: [
    {
      question: "How many DML statements and SOQL queries were consumed?",
      limits: ["dmlStatements", "soqlQueries"],
    },
    {
      question: "Are we close to any governor limit?",
      limits: ["cpuTime", "heapSize", "queryRows", "dmlRows"],
    },
    {
      question: "Which searches and future calls did it use?",
      limits: ["soslQueries", "futureCalls"],
    },
    {
      question: "Which namespace consumed the limits?",
      keys: ["limitsByNamespace"],
    },
    {
      question: "How long did the transaction take, and how big is the log?",
      fields: ["durationTotalMs", "fileSizeBytes"],
    },
    {
      question: "Where did the time go — methods, queries or a managed package?",
      keys: ["timeByKind"],
      columns: ["kind", "operationCount", "durationSelfMs"],
    },
    {
      question: "Is detail missing because a log category was switched off?",
      keys: ["debugLevels"],
      columns: ["logCategory", "level"],
    },
    {
      question: "Did the log parse cleanly, and did it capture the whole run?",
      fields: ["parsingErrorCount"],
      keys: ["truncated"],
    },
    { question: "Which namespaces ran?", keys: ["namespaces"] },
  ],
  apexlog_list_slow_operations: [
    { question: "What did the transaction spend its time on?", keys: ["operations"] },
    {
      question: "Was it a method, a query, a search or DML?",
      keys: ["operations"],
      columns: ["kind", "callCount"],
    },
    {
      question: "What share of the runtime do those operations account for?",
      fields: ["returnedSelfPercentage", "durationTotalMs"],
    },
    {
      question: "Did any of them touch the database, and how much did they move?",
      keys: ["operations"],
      columns: ["dmlCount", "soqlCount", "soslCount", "rowCount"],
    },
    {
      question: "Whose namespace are they in?",
      keys: ["operations"],
      columns: ["namespace"],
    },
    {
      question: "Is it one slow call or many cheap ones?",
      keys: ["operations"],
      columns: ["callCount", "durationSelfMaxMs"],
    },
    {
      question: "Was the log captured at a level that hides work inside these rows?",
      keys: ["apexCodeLevel", "systemLevel", "dbLevel", "workflowLevel"],
    },
    {
      question: "Did the row cap hide operations the selection matched?",
      fields: ["matchedCount"],
    },
    {
      // Only where a query was ranked and the log recorded a plan for it.
      // `minimal.log` runs no query, and an absent table is the honest answer.
      fixture: "governor-heavy",
      question: "Will the optimizer treat those queries as selective?",
      keys: ["queryPlans"],
      columns: ["leadingOperationType", "relativeCost", "sObjectCardinality"],
    },
  ],
  apexlog_list_limit_risks: [
    {
      question: "Is any governor limit nearly consumed?",
      keys: ["atRisk"],
    },
    {
      question: "How near does a limit have to be to appear here?",
      fields: ["threshold"],
    },
    {
      question: "Was the log captured at a level that hides what consumed a limit?",
      keys: ["apexCodeLevel", "systemLevel", "dbLevel", "workflowLevel"],
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
  apexlog_get_summary: {
    fields: ["parsingErrorCount"],
    allLimitsZero: true,
  },
};

/**
 * chars/4 ceilings, each about 5% above what the case currently costs. Tight
 * enough that a response cannot creep back to its pre-shaping size and still
 * pass, loose enough that adding one field is a deliberate budget edit rather
 * than a surprise failure.
 */
const TOKEN_BUDGET = {
  // Raised for the two tables #62 added: what each namespace consumed of the
  // limits, and where the time went by kind of operation. Both answer questions
  // the 1.x summary could not.
  "apexlog_get_summary/governor-heavy": 357,
  "apexlog_get_summary/minimal": 249,
  // Raised for the grouped default #126 made: every row now carries its call
  // count and the self time of its slowest call, and for the four capture levels
  // #102 added, which say how much of the transaction reached the log at all,
  // and for the `matchedCount` #63 added, which says whether the row cap hid
  // anything the selection matched, and for the query plans #120 added, which
  // say whether the optimizer treats a ranked query as selective.
  "apexlog_list_slow_operations/governor-heavy": 410,
  "apexlog_list_slow_operations/minimal": 130,
  "apexlog_list_limit_risks/governor-heavy": 41,
  "apexlog_list_limit_risks/minimal": 26,
};

/**
 * What 1.x cost, so the README can show what changed. Both sets were measured
 * once, through this same stdio path and this same estimator, against the server
 * built at b79328f — the commit before the shaping work. Static on purpose: a
 * released figure cannot change.
 */
const V1_DEFINITION_TOKENS = {
  apexlog_list_slow_operations: 247,
  apexlog_get_summary: 171,
  apexlog_list_limit_risks: 267,
  apexlog_execute_anonymous: 844,
};

const V1_RESPONSE_TOKENS = {
  "apexlog_get_summary/governor-heavy": 293,
  "apexlog_get_summary/minimal": 249,
  "apexlog_list_slow_operations/governor-heavy": 408,
  "apexlog_list_slow_operations/minimal": 190,
  "apexlog_list_limit_risks/governor-heavy": 84,
  "apexlog_list_limit_risks/minimal": 30,
};

/**
 * What each tool definition costs in `tools/list`, which every request carries
 * whether or not a tool is called. Measured over the whole wire object, because
 * a budget on a chosen subset leaves the rest of the object unwatched. Same 5%
 * headroom as TOKEN_BUDGET: a longer description is a deliberate budget edit,
 * not a silent tax on every request.
 */
const DEFINITION_BUDGET = {
  // Raised for the five selection parameters, which the caller acts on: without
  // them a ranking over every operation kind can only be read whole, and for the
  // warning that a grouped durationTotalMs must not be summed across rows, and
  // for what grouping by default now states about the row it returns, and for
  // callerNamespace, which needs a clause to say what it attributes, and for the
  // clause #120 added to say the response also carries the query plans.
  apexlog_list_slow_operations: 392,
  // Raised for the two facts the summary gained: per-namespace limit usage, and
  // time by kind of operation.
  apexlog_get_summary: 180,
  apexlog_list_limit_risks: 210,
  apexlog_execute_anonymous: 449,
};

/**
 * The whole of `tools/list` must stay under what 1.x charged for it. The per-tool
 * budgets cannot assert this on their own — a fifth tool would pass all four and
 * still put the total back over the baseline.
 */
const TOTAL_DEFINITION_BUDGET = Object.values(V1_DEFINITION_TOKENS).reduce(
  (sum, tokens) => sum + tokens,
  0,
);

/**
 * The words a client's tool search matches on. Asserted so that a trim which
 * saves tokens cannot quietly cost discovery: a cheaper description that no
 * longer says "governor limits" is a regression, not a saving.
 */
const SELECTION_KEYWORDS = {
  apexlog_list_slow_operations: ["self-execution time", "optimize"],
  apexlog_get_summary: ["summary", "overview"],
  apexlog_list_limit_risks: ["governor limits", "CPU time"],
  apexlog_execute_anonymous: ["anonymous Apex", "Salesforce org"],
};

const CASES = [
  "apexlog_get_summary",
  "apexlog_list_slow_operations",
  "apexlog_list_limit_risks",
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
    async listTools() {
      const response = await request("tools/list", {});
      const tools = response.result?.tools;
      if (!Array.isArray(tools)) {
        throw new Error(`tools/list returned no tools: ${JSON.stringify(response)}`);
      }
      return tools;
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
  const columns = new Map();
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
        columns.set(
          key,
          new Set(header.split(",").map((column) => column.trim())),
        );
      } else if (value !== "" && !line.endsWith(":")) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && /^-?[\d.]+$/.test(value)) {
          scalars.set(key, numeric);
        } else {
          // Prose at the top level — a `note`, or a reintroduced `summary`.
          // Scanned for restated figures below.
          strings.push(value);
        }
      }
      continue;
    }
    const indented = line.trim();
    const cells = indented.split(",");
    table.set(cells[0], cells);
  }

  return { scalars, keys, columns, tables, strings };
}

function checkAnswerability({ tool, fixture }, toon, failures) {
  const { scalars, keys, columns, tables } = inspect(toon);
  const limitRows = tables.get("governorLimits") ?? new Map();

  for (const check of ANSWERABILITY[tool]) {
    // A question only some logs raise is pinned on the fixture that raises it.
    if (check.fixture && check.fixture !== fixture) continue;

    const missing = [];
    for (const field of check.fields ?? []) {
      if (!scalars.has(field)) missing.push(field);
    }
    for (const key of check.keys ?? []) {
      if (!keys.includes(key)) missing.push(key);
    }
    // A column belongs to one table. Pooling every header into one set let a
    // check pass on a column another table happened to carry.
    if (check.columns) {
      const [table, ...rest] = check.keys ?? [];
      if (!table || rest.length) {
        throw new Error(
          `${tool}: a "columns" check names the one table they are in, in "keys" — "${check.question}"`,
        );
      }
      const header = columns.get(table) ?? new Set();
      for (const column of check.columns) {
        if (!header.has(column)) missing.push(`${table}.${column}`);
      }
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
  // future one would do again. Table rows are out of scope: a cell that reads
  // like a scalar is another measurement of another thing, not a restatement.
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
  const tokens = estimateTokens(toon);
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

/**
 * What an agent pays for a tool it has not called: the definition exactly as the
 * client receives it, whole. Not a subset — `title`, `annotations` and the SDK's
 * own fields cost the same tokens as the description does, and a budget that
 * cannot see them cannot hold them down.
 */
function definitionCosts(tools) {
  return tools
    .map((tool) => ({
      name: tool.name,
      tokens: estimateTokens(JSON.stringify(tool)),
      description: tool.description ?? "",
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function checkDefinitionBudget(costs, failures) {
  for (const { name, tokens } of costs) {
    const budget = DEFINITION_BUDGET[name];
    if (budget === undefined) {
      failures.push(`${name}: no definition budget declared`);
    } else if (tokens > budget) {
      failures.push(
        `${name}: definition is ~${tokens} tokens, over its budget of ${budget}`,
      );
    }
  }
  for (const name of Object.keys(DEFINITION_BUDGET)) {
    if (!costs.some((cost) => cost.name === name)) {
      failures.push(`${name}: budgeted but absent from tools/list`);
    }
  }
  const total = costs.reduce((sum, cost) => sum + cost.tokens, 0);
  if (total > TOTAL_DEFINITION_BUDGET) {
    failures.push(
      `tools/list is ~${total} tokens, over the ${TOTAL_DEFINITION_BUDGET} that 1.x charged for it`,
    );
  }
}

function checkSelectionKeywords(costs, failures) {
  for (const { name, description } of costs) {
    const lowered = description.toLowerCase();
    for (const keyword of SELECTION_KEYWORDS[name] ?? []) {
      if (!lowered.includes(keyword.toLowerCase())) {
        failures.push(`${name}: description no longer says "${keyword}"`);
      }
    }
  }
}

/** Pads cells so the pipes line up, which is what markdownlint MD060 wants. */
function renderTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

const thousands = (value) => value.toLocaleString("en-US");

/** The two comparison cells: what 1.x cost, and the signed change since. */
function comparison(before, after) {
  if (before === undefined) {
    return ["—", "—"];
  }
  const change = Math.round((100 * (after - before)) / before);
  return [`~${thousands(before)}`, `${change > 0 ? "+" : ""}${change}%`];
}

/**
 * The README tables, generated so the published figures cannot go stale. Only
 * the tables: the prose around them stays in the README, where it is edited.
 */
function renderTokenCost(costs, responses) {
  const total = costs.reduce((sum, cost) => sum + cost.tokens, 0);
  const share = ((100 * total) / CONTEXT_WINDOW).toFixed(1);
  const [v1TotalCell, totalChange] = comparison(TOTAL_DEFINITION_BUDGET, total);

  return [
    {
      id: "token-cost-definitions",
      table: renderTable(
        ["Tool", "Tokens", "1.x", "Change"],
        [
          ...costs.map(({ name, tokens }) => [
            `\`${name}\``,
            `~${thousands(tokens)}`,
            ...comparison(V1_DEFINITION_TOKENS[name], tokens),
          ]),
          [
            "**Total**",
            `**~${thousands(total)}** (${share}% of a 200K context)`,
            `**${v1TotalCell}**`,
            `**${totalChange}**`,
          ],
        ],
      ),
    },
    {
      id: "token-cost-answers",
      table: renderTable(
        ["Tool", "Log", "Response", "1.x", "Change"],
        responses.map(({ tool, fixture, tokens }) => [
          `\`${tool}\``,
          `\`${fixture}.log\``,
          `~${thousands(tokens)}`,
          ...comparison(V1_RESPONSE_TOKENS[`${tool}/${fixture}`], tokens),
        ]),
      ),
    },
  ];
}

async function checkReadme(blocks, failures, update) {
  let readme = await fs.readFile(README, "utf-8");
  let stale = false;

  for (const { id, table } of blocks) {
    const startMarker = `<!-- ${id}:start -->`;
    const endMarker = `<!-- ${id}:end -->`;
    const start = readme.indexOf(startMarker);
    const end = readme.indexOf(endMarker);
    if (start === -1 || end === -1) {
      failures.push(
        `README.md: missing the ${startMarker} / ${endMarker} markers the table goes between`,
      );
      continue;
    }
    const wanted = `\n\n${table}\n\n`;
    if (readme.slice(start + startMarker.length, end) === wanted) {
      continue;
    }
    stale = true;
    readme = `${readme.slice(0, start + startMarker.length)}${wanted}${readme.slice(end)}`;
  }

  if (!stale) {
    return;
  }
  if (update) {
    await fs.writeFile(README, readme, "utf-8");
    return;
  }
  failures.push(
    "README.md: the token cost tables no longer match this run. Run `pnpm run eval:update` and commit the diff.",
  );
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
        `${tool}: ${toon.length} chars, ~${estimateTokens(toon)} tokens`,
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

  const responses = [];

  await withClient(async (client) => {
    for (const testCase of CASES) {
      const logFilePath = path.join(FIXTURES, `${testCase.fixture}.log`);
      const toon = await client.callTool(testCase.tool, { logFilePath });
      checkAnswerability(testCase, toon, failures);
      checkNoDuplication(testCase, toon, failures);
      const tokens = checkTokenBudget(testCase, toon, failures);
      await checkGolden(testCase, toon, failures, update);
      responses.push({ ...testCase, tokens });
      console.log(
        `${update ? "updated" : "checked"} ${testCase.tool}/${testCase.fixture} — ~${tokens} tokens`,
      );
    }

    const costs = definitionCosts(await client.listTools());
    checkDefinitionBudget(costs, failures);
    checkSelectionKeywords(costs, failures);
    await checkReadme(renderTokenCost(costs, responses), failures, update);
    const total = costs.reduce((sum, cost) => sum + cost.tokens, 0);
    console.log(
      `${update ? "updated" : "checked"} tool definitions — ~${total} tokens across ${costs.length} tools`,
    );
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
