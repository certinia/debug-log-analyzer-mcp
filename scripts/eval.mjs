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
      question: "Did the run fail, and can I trust these numbers?",
      fields: ["thrownCount"],
      keys: ["truncated"],
    },
    {
      // Only where the run died. `fatalErrors` is the one field that says the
      // transaction did not finish, and a fatal that breaches no limit is
      // invisible in every other field.
      fixture: "governor-heavy",
      question: "What killed the transaction, and where?",
      keys: ["fatalErrors"],
      columns: ["message", "frames"],
    },
    {
      // Only where the platform dropped content, which gates the field.
      fixture: "truncated",
      question: "How much of the log is missing?",
      fields: ["skippedBytes"],
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
const MINIMAL_FIXTURE = "minimal";

const MINIMAL_ZEROS = {
  apexlog_get_summary: {
    fields: ["thrownCount"],
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
  // the 1.x summary could not. Raised again for the stack frames #100 added to
  // a fatal: the message names the limit, the frames name the code, and 18 of 42
  // fatals across a 124-log corpus breach no limit at all, so nothing else in
  // the response reveals them.
  "apexlog_get_summary/governor-heavy": 397,
  "apexlog_get_summary/minimal": 249,
  // Raised for the grouped default #126 made: every row now carries its call
  // count and the self time of its slowest call, and for the four capture levels
  // #102 added, which say how much of the transaction reached the log at all,
  // and for the `matchedCount` #63 added, which says whether the row cap hid
  // anything the selection matched, and for the query plans #120 added, which
  // say whether the optimizer treats a ranked query as selective.
  "apexlog_list_slow_operations/governor-heavy": 410,
  "apexlog_list_slow_operations/minimal": 130,
  // Raised for the fifth capture level #97 added. A callout is a timed event to
  // the published parser, so it is ranked, and a ranked kind has to state the
  // level that gates it or a zero cannot be read.
  "apexlog_list_limit_risks/governor-heavy": 46,
  "apexlog_list_limit_risks/minimal": 30,
  "apexlog_get_summary/heap-heavy": 269,
  "apexlog_get_summary/truncated": 252,
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
  // clause #120 added to say the response also carries the query plans, and
  // for `offset` beside the whole-number floor on `limit` — a schema that
  // states `integer` and `minimum` costs tokens, and buys a `limit` of -5 no
  // longer returning the whole ranking bar its five fastest rows, and for the
  // clause saying
  // a plan names its row except under a namespace grouping — an agent that
  // assumes the query text is always there reads `undefined` — and for telling
  // a caller to advance `offset` by the rows it got, since the page budget can
  // return fewer than `limit` and paging by `limit` would then skip rows.
  apexlog_list_slow_operations: 470,
  // Raised for the two facts the summary gained: per-namespace limit usage, and
  // time by kind of operation.
  apexlog_get_summary: 180,
  apexlog_list_limit_risks: 210,
  apexlog_execute_anonymous: 449,
};

/**
 * What `tools/list` must tell a 2026-07-28 client about caching its answer. The
 * definitions are fixed for the life of the process and hold nothing about the
 * caller, so an hour and a shared cache are both safe. Without it the SDK emits
 * the conservative `{ ttlMs: 0, cacheScope: "private" }` and every client pays
 * the definition budget again on every turn.
 */
const TOOLS_LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" };

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

/**
 * Which logs each tool is measured against.
 *
 * Declared per tool rather than as a cross product of tools and fixtures. Every
 * case is a server round trip and a golden file a reviewer has to read, so a
 * case earns its place only by pinning something the others would miss — and a
 * cross product spends three cases on a fixture that answers one question.
 * `heap-heavy` is here for `apexlog_get_summary` alone, the one tool whose
 * answer its heap changes. `apexlog_list_limit_risks` does read heap, but this
 * log's heap sits under its risk threshold, and the rows
 * `apexlog_list_slow_operations` would rank are kinds `governor-heavy` pins
 * already.
 */
const FIXTURES_BY_TOOL = {
  apexlog_get_summary: ["governor-heavy", "minimal", "heap-heavy", "truncated"],
  apexlog_list_slow_operations: ["governor-heavy", "minimal"],
  apexlog_list_limit_risks: ["governor-heavy", "minimal"],
};

/**
 * The one log the README publishes a cost against.
 *
 * The answers table is keyed on tools rather than on cases, so a fixture added
 * to pin a correctness fact does not also add a published row. `governor-heavy`
 * is the log every tool is measured against, and the only one with a 1.x
 * baseline to compare against. Why a bigger log would not move the figures is
 * in the README, beside the table itself.
 */
const PUBLISHED_FIXTURE = "governor-heavy";

const CASES = Object.entries(FIXTURES_BY_TOOL).flatMap(([tool, fixtures]) =>
  fixtures.map((fixture) => ({ tool, fixture })),
);

const CASE_KEYS = new Set(
  CASES.map(({ tool, fixture }) => `${tool}/${fixture}`),
);

/**
 * Everything declared per case has to name a case the run measures.
 *
 * Nothing else notices a case that stops being run: `checkAnswerability` skips
 * a check whose fixture is not the one in hand and the minimal-zeros block at
 * its tail returns early off the same test, `checkTokenBudget` only reports a
 * budget that is missing, and a retired case's golden file simply stops being
 * read. So dropping a fixture or a tool from `FIXTURES_BY_TOOL` retires every
 * check scoped to it and the run still passes.
 *
 * `PUBLISHED_FIXTURE` has the hole too, from the other side: the answers block
 * renders whichever cases match it, so a tool that stops being measured against
 * it loses its published row rather than failing.
 *
 * `SELECTION_KEYWORDS` has the same hole but is keyed by what `tools/list`
 * returns rather than by a case, so `checkDefinitionBudget` is where it belongs.
 */
function checkChecksAreRun(failures) {
  const notRun = (tool, fixture) => !CASE_KEYS.has(`${tool}/${fixture}`);

  for (const [tool, checks] of Object.entries(ANSWERABILITY)) {
    if (!FIXTURES_BY_TOOL[tool]?.length) {
      failures.push(
        `${tool}: ${checks.length} answerability check(s) declared, but the tool is measured against no fixture`,
      );
    }
    for (const { question, fixture } of checks) {
      if (fixture && notRun(tool, fixture)) {
        failures.push(
          `${tool}: "${question}" is pinned on ${fixture}, which this run does not measure`,
        );
      }
    }
  }

  for (const tool of Object.keys(MINIMAL_ZEROS)) {
    if (notRun(tool, MINIMAL_FIXTURE)) {
      failures.push(
        `${tool}: the zeros it must report are pinned on ${MINIMAL_FIXTURE}, which this run does not measure`,
      );
    }
  }

  for (const [what, declared] of [
    ["a token budget", TOKEN_BUDGET],
    ["a 1.x response cost", V1_RESPONSE_TOKENS],
  ]) {
    for (const key of Object.keys(declared)) {
      if (!CASE_KEYS.has(key)) {
        failures.push(
          `${key}: ${what} is declared for a case this run does not measure`,
        );
      }
    }
  }

  for (const tool of Object.keys(FIXTURES_BY_TOOL)) {
    if (!ANSWERABILITY[tool]) {
      failures.push(
        `${tool}: measured against ${FIXTURES_BY_TOOL[tool].length} fixture(s) with no answerability checks declared`,
      );
    }
    if (notRun(tool, PUBLISHED_FIXTURE)) {
      failures.push(
        `${tool}: the README publishes a cost against ${PUBLISHED_FIXTURE}, which this run does not measure it against`,
      );
    }
  }
}

/**
 * What a 2026-07-28 request carries in place of the `initialize` handshake. The
 * era is per connection, so a client that has initialized stays legacy however a
 * later request is addressed.
 */
const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "apex-log-mcp-eval", version: "0" },
};

/** Minimal MCP stdio client: initialize, then one tools/call per case. */
function createClient(era = "legacy") {
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
      const addressed =
        era === "modern" ? { ...params, _meta: MODERN_ENVELOPE } : params;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: addressed })}\n`,
      );
    });

  return {
    async start() {
      if (era === "modern") return;
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "apex-log-mcp-eval", version: "0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    async toolsList() {
      const response = await request("tools/list", {});
      if (!Array.isArray(response.result?.tools)) {
        throw new Error(`tools/list returned no tools: ${JSON.stringify(response)}`);
      }
      return response.result;
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

  for (const check of ANSWERABILITY[tool] ?? []) {
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

  if (fixture !== MINIMAL_FIXTURE) {
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

/** Only a 2026-07-28 connection carries the fields, so this needs a modern client. */
function checkCacheHints(result, failures) {
  for (const [field, expected] of Object.entries(TOOLS_LIST_CACHE_HINT)) {
    if (result[field] !== expected) {
      failures.push(
        `tools/list: ${field} is ${JSON.stringify(result[field])}, not ${JSON.stringify(expected)}`,
      );
    }
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
        ["Tool", "Response", "1.x", "Change"],
        responses
          .filter(({ fixture }) => fixture === PUBLISHED_FIXTURE)
          .map(({ tool, tokens }) => [
            `\`${tool}\``,
            `~${thousands(tokens)}`,
            ...comparison(
              V1_RESPONSE_TOKENS[`${tool}/${PUBLISHED_FIXTURE}`],
              tokens,
            ),
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
async function withClient(run, era) {
  const client = createClient(era);
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

  checkChecksAreRun(failures);

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

    const costs = definitionCosts((await client.toolsList()).tools);
    checkDefinitionBudget(costs, failures);
    checkSelectionKeywords(costs, failures);
    await checkReadme(renderTokenCost(costs, responses), failures, update);
    const total = costs.reduce((sum, cost) => sum + cost.tokens, 0);
    console.log(
      `${update ? "updated" : "checked"} tool definitions — ~${total} tokens across ${costs.length} tools`,
    );
  });

  await withClient(async (client) => {
    checkCacheHints(await client.toolsList(), failures);
    console.log(
      `checked tools/list cache hint — ttlMs ${TOOLS_LIST_CACHE_HINT.ttlMs}, cacheScope ${TOOLS_LIST_CACHE_HINT.cacheScope}`,
    );
  }, "modern");

  if (failures.length) {
    console.error(`\n${failures.length} eval failure(s):`);
    failures.forEach((failure) => console.error(`  ✗ ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log(`\n${CASES.length} eval case(s) passed.`);
}

await main();
