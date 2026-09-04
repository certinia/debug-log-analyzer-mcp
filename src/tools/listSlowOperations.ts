/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import type { ApexLog } from "@apexdevtools/apex-log-parser";
import { encode } from "@toon-format/toon";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import {
  captureLevels,
  GROUP_BY,
  groupOperations,
  listOperations,
  operationGroupKey,
  OPERATION_KINDS,
  type CaptureLevels,
  type GroupBy,
  type Operation,
  type OperationKind,
} from "./operations.js";
import {
  listQueryPlans,
  planOf,
  type QueryPlan,
  type QueryPlanVerdict,
} from "./queryPlans.js";
import {
  NS_TO_MS,
  omitEmpty,
  roundMs,
  roundPercent,
} from "./responseShaping.js";

export const listSlowOperationsInputSchema = {
  logFilePath: logFilePathSchema,
  kind: z
    .enum(OPERATION_KINDS)
    .optional()
    .describe("Rank only operations of this kind"),
  namespace: z.string().optional().describe("Rank only this namespace"),
  minSelfMs: z
    .number()
    .optional()
    .describe("Drop operations below this self time (default: 0)"),
  limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Page size (default: 10); fewer if the page would be too large"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Ranked rows to skip (default: 0). Advance it by the rows you got, which can be fewer than limit.",
    ),
  groupBy: z
    .enum([...GROUP_BY, "none"])
    .optional()
    .describe(
      "Fold repeats into one row: by name (default), by namespace, or by callerNamespace, which attributes platform DML to the package that drove it. A grouped durationTotalMs is what the transaction takes back if the group never runs — never sum it across rows. Pass none to rank each call on its own.",
    ),
};

/**
 * The longest query text reported on a row.
 *
 * Names are short until they are not: across 23,456 rows of a 124-log corpus
 * the median is 50 characters and the p90 is 100, but the longest is 19,593 —
 * about 4,900 tokens for one row. Eliding at 400 touches 2% of rows and takes
 * the whole tail with it.
 */
const NAME_LIMIT = 400;

/**
 * The most one page of rows may cost, as characters.
 *
 * About 15,000 tokens at the four-characters-a-token estimate `scripts/eval.mjs`
 * measures with, which leaves headroom under the 25,000-token response ceiling
 * a client is likely to impose. Eliding names is not enough on its own: a
 * thousand rows cost some 15,000 tokens in their numeric columns alone, so 5
 * logs in that corpus still breached the ceiling with every name capped.
 */
const PAGE_CHAR_BUDGET = 60_000;

export type SlowOperationsArgs = z.infer<
  z.ZodObject<typeof listSlowOperationsInputSchema>
>;

export const listSlowOperationsToolConfig = {
  title: "List Slow Apex Log Operations",
  description:
    "Rank what an Apex debug log spent its time on by self-execution time — code units, methods, queries, searches, DML, flows and workflows in one table, each row with its calls, durations, database counts and rows, so the caller can see what to optimize and why, beside the query optimizer's plan for the queries among them. A plan names its row, or the query itself under a namespace grouping.",
  inputSchema: listSlowOperationsInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/** One ranked row, in the units and the order the payload uses. */
export interface SlowOperation {
  kind: OperationKind;
  name: string;
  namespace: string;
  callCount: number;
  /**
   * On a grouped row, what the transaction takes back if the group never runs.
   * Never additive across rows — one row's callees are another row's calls.
   */
  durationTotalMs: number;
  durationSelfMs: number;
  /** Absent on an ungrouped row, where it is `durationSelfMs` again. */
  durationSelfMaxMs?: number;
  selfPercentage: number;
  soqlCount: number;
  dmlCount: number;
  soslCount: number;
  rowCount: number;
  thrownCount: number;
}

export interface SlowOperationsResult extends CaptureLevels {
  durationTotalMs: number;
  /**
   * Share of the transaction the returned rows account for between them. A low
   * figure says the cost is spread across everything else rather than
   * concentrated here — the one thing the table itself does not say.
   */
  returnedSelfPercentage: number;
  /**
   * Rows the selection matched, before `offset`, `limit` or the page budget cut
   * it. Above the returned count it says rows were held back, which no other
   * figure in the response states.
   */
  matchedCount: number;
  operations: SlowOperation[];
  /**
   * What the query optimiser decided about the queries behind those rows, one
   * row per distinct query text it explained — a grouped row can stand for
   * several. Absent when it explained none of them: an
   * explain is emitted at `DB,FINEST` alone, and `dbLevel` says whether the log
   * could carry one.
   *
   * A separate table rather than a column, because `relativeCost` is null on
   * every row that is not a query, and a table whose rows share no key set
   * costs more than it says.
   *
   * Keyed by `operationRow` where the ranked row is already named after the
   * query, and by `name` where it is not — see `PlanRow`.
   */
  queryPlans?: PlanRow[];
}

/**
 * A plan under the ranked row it explains, for a grouping that names the row
 * after the query itself.
 *
 * The query is then named by that row — elided past `NAME_LIMIT` like any other
 * name — and repeating it here would state one string twice: p90 1,364 tokens
 * across a 124-log corpus and 4,699 at worst. `operationRow` is the 1-based
 * line of `operations` as returned, so it stays right under paging and can only
 * name a row the response carries.
 */
export interface RankedPlan extends QueryPlanVerdict {
  operationRow: number;
}

/**
 * Grouping by namespace names the row after the namespace, so the query text
 * appears nowhere else and has to stay.
 */
export type PlanRow = RankedPlan | QueryPlan;

/** The verdict without the query text, spelled out so a new field is a decision. */
function verdictOf(plan: QueryPlan): QueryPlanVerdict {
  return {
    leadingOperationType: plan.leadingOperationType,
    relativeCost: plan.relativeCost,
    cardinality: plan.cardinality,
    sObjectCardinality: plan.sObjectCardinality,
  };
}

/**
 * Keep the head and the tail of an over-long name, and say so in the middle.
 *
 * The middle goes rather than the end, because a query names its columns first
 * and its object last, and dropping the `FROM` clause would leave a row the
 * caller cannot identify.
 *
 * Measured in UTF-16 units, which is what the name costs to send, and cut by
 * slicing rather than by walking the string: on a name of the length above,
 * that is 0.16 microseconds against 56.
 */
function elide(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = maxChars - 1 - head;
  // A cut inside a surrogate pair would send half a character, so step off it.
  const first = text.charCodeAt(head - 1);
  const from = first >= 0xd800 && first <= 0xdbff ? head - 1 : head;
  const last = text.charCodeAt(text.length - tail);
  const to =
    last >= 0xdc00 && last <= 0xdfff
      ? text.length - tail + 1
      : text.length - tail;
  return `${text.slice(0, from)}…${text.slice(to)}`;
}

/**
 * What a row costs on the wire, near enough to bound a page by.
 *
 * An estimate, not the encoded length: it counts each cell and a separator,
 * where TOON also indents the row and quotes any cell holding a comma. It
 * therefore under-counts, by 3% on the worst page of a 124-log corpus — which
 * the budget's own headroom absorbs, since 60,000 characters is well under the
 * 100,000 a 25,000-token ceiling allows.
 */
function rowCost(row: SlowOperation | PlanRow): number {
  return Object.values(row).reduce(
    (total, cell) => total + String(cell).length + 1,
    0,
  );
}

/**
 * Plans for the ranked rows named after their query, in rank order.
 *
 * One row per ranked query row that was explained, not one per query text: the
 * same query can rank on several rows — 23 of them in one real log ranked
 * ungrouped, and two whenever one text runs in two namespaces — and the row is
 * now the only thing that identifies which. Stating the verdict once would
 * leave every other row of the same query reading as unexplained. It repeats
 * only the four small figures, never the text.
 *
 * A page with no query among its rows pays nothing for the second walk.
 *
 * Where a row is one call — `groupBy: "none"` — the plan comes from that call's
 * own event, not from the worst plan for its text. The row makes a claim about
 * one call, and 13 query texts across a 124-log corpus were explained at more
 * than one `relativeCost`, so the worst would tell those rows a cost the
 * optimiser did not reach for them. A grouped row stands for every call of the
 * text, where the worst is the figure to act on.
 */
function plansForRankedRows(
  ranked: Operation[],
  apexLog: ApexLog,
  perCall: boolean,
): RankedPlan[] {
  if (!ranked.some((operation) => operation.kind === "soql")) {
    return [];
  }

  const explained = perCall ? undefined : listQueryPlans(apexLog);
  const plans: RankedPlan[] = [];
  ranked.forEach((operation, index) => {
    if (operation.kind !== "soql") {
      return;
    }
    const plan = explained
      ? explained.get(operation.name)
      : planOf(operation.node);
    if (plan) {
      plans.push({ operationRow: index + 1, ...verdictOf(plan) });
    }
  });
  return plans;
}

/**
 * Plans behind the ranked rows that are named after a namespace.
 *
 * The row does not name the query, so the plan has to. One namespace row can
 * stand for several queries, so the group key is what finds them — and the
 * queries are looked for in the whole selection rather than the page, because
 * the row is a fold of operations the page does not list.
 */
function plansForNamespaceRows(
  selected: Operation[],
  ranked: Operation[],
  groupBy: GroupBy,
  apexLog: ApexLog,
): QueryPlan[] {
  const rankedKeys = new Set(
    ranked.map((operation) => operationGroupKey(operation, groupBy)),
  );
  const queryNames = new Set(
    selected
      .filter(
        (operation) =>
          operation.kind === "soql" &&
          rankedKeys.has(operationGroupKey(operation, groupBy)),
      )
      .map((operation) => operation.name),
  );
  if (queryNames.size === 0) {
    return [];
  }

  const explained = listQueryPlans(apexLog);
  return [...queryNames]
    .map((name) => explained.get(name))
    .filter((plan): plan is QueryPlan => plan !== undefined)
    // The same cap as a row's name: this is the one path where a query text is
    // still reported, so it is the one path that would otherwise ship 19,593
    // characters of it.
    .map((plan) => ({ ...plan, name: elide(plan.name, NAME_LIMIT) }));
}

export async function listSlowOperations(args: SlowOperationsArgs) {
  const {
    logFilePath,
    kind,
    namespace,
    minSelfMs = 0,
    limit = 10,
    offset = 0,
    groupBy = "name",
  } = args;

  const apexLog = await loadApexLog(logFilePath);
  const durationTotalNs = apexLog.duration.total;
  const minSelfNs = minSelfMs * NS_TO_MS;

  const selected = listOperations(apexLog).filter(
    (operation) =>
      (!kind || operation.kind === kind) &&
      (!namespace || operation.namespace === namespace),
  );

  const grouped = groupBy !== "none";

  // Grouped before the threshold, so a query that is slow only because it runs
  // four hundred times is kept rather than dropped call by call.
  const rows = grouped ? groupOperations(selected, groupBy) : selected;

  const matched = rows
    // Tested as ">= keep" rather than "< drop": a malformed timestamp parses to
    // NaN, which fails both, and such an operation must be dropped, not ranked.
    .filter((operation) => operation.durationSelfNs >= minSelfNs)
    // Stable by specification, and the sort key is one number, so a caller
    // walking the ranking with `offset` sees each row once and in one order.
    .sort((a, b) => b.durationSelfNs - a.durationSelfNs);
  const page = matched.slice(offset, offset + limit);

  const selfPercentageOf = (operation: Operation) =>
    durationTotalNs > 0 ? (operation.durationSelfNs / durationTotalNs) * 100 : 0;

  // The column set is spelled out rather than spread, so the compiler fails the
  // build if an `Operation` field is added without deciding whether it belongs
  // on the wire, and so the columns arrive in a readable order. It is a fixed
  // set: a zero SOQL count reads as "none" rather than "not measured".
  const toRow = (operation: Operation): SlowOperation => ({
    kind: operation.kind,
    name: elide(operation.name, NAME_LIMIT),
    namespace: operation.namespace,
    callCount: operation.callCount,
    durationTotalMs: roundMs(operation.durationTotalNs / NS_TO_MS),
    durationSelfMs: roundMs(operation.durationSelfNs / NS_TO_MS),
    // On an ungrouped row the slowest call is the row itself, and a response
    // states each figure once.
    ...(grouped && {
      durationSelfMaxMs: roundMs(operation.durationSelfMaxNs / NS_TO_MS),
    }),
    selfPercentage: roundPercent(selfPercentageOf(operation)),
    soqlCount: operation.soqlCount,
    dmlCount: operation.dmlCount,
    soslCount: operation.soslCount,
    rowCount: operation.rowCount,
    thrownCount: operation.thrownCount,
  });

  // Built and costed in one pass, so a row the budget turns away is never
  // built, and `operations` is a prefix of `page` by construction rather than
  // by an invariant the next reader has to take on trust — which is what lets
  // a plan's `operationRow` name a row safely. At least one row always comes
  // back, so a single enormous row is reported rather than the table quietly
  // going empty. Rows returned read against `matchedCount` say the page was
  // cut, which needs no field of its own.
  const operations: SlowOperation[] = [];
  let spent = 0;
  for (const operation of page) {
    const row = toRow(operation);
    spent += rowCost(row);
    if (spent > PAGE_CHAR_BUDGET && operations.length > 0) {
      break;
    }
    operations.push(row);
  }

  // Kept in step by construction — the loop above appends in order and stops —
  // so a plan's `operationRow` can only name a row the response carries.
  const ranked = page.slice(0, operations.length);

  // Only the returned rows are explained, so the table qualifies what the
  // response says rather than ranking a second time. Grouping by name, and
  // ranking each call on its own, both name a query row after the query, so
  // the plan points at the row; grouping by namespace does not, so it looks
  // the queries up by group key and carries the text.
  const explained: PlanRow[] =
    groupBy === "name" || groupBy === "none"
      ? plansForRankedRows(ranked, apexLog, groupBy === "none")
      : plansForNamespaceRows(selected, ranked, groupBy, apexLog);

  // Out of what the rows left, because the plans are part of the same response.
  // A namespace grouping reports one plan per distinct query text behind the
  // rows, each carrying up to `NAME_LIMIT` characters of that text and none of
  // it bounded by the row cap — 30 such rows were 90% of a real response. The
  // rows come first: a plan qualifies a row, so a plan without its row says
  // nothing.
  const queryPlans: PlanRow[] = [];
  for (const plan of explained) {
    spent += rowCost(plan);
    if (spent > PAGE_CHAR_BUDGET) {
      break;
    }
    queryPlans.push(plan);
  }

  const result: SlowOperationsResult = {
    ...captureLevels(apexLog),
    durationTotalMs: roundMs(durationTotalNs / NS_TO_MS),
    returnedSelfPercentage: roundPercent(
      ranked.reduce((total, operation) => total + selfPercentageOf(operation), 0),
    ),
    matchedCount: matched.length,
    operations,
    ...omitEmpty({ queryPlans }),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: encode(result),
      },
    ],
  };
}
