/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type {
  ApexLog,
  LogEvent,
  SOQLExecuteExplainLine,
} from "@apexdevtools/apex-log-parser";
import { walkLog } from "./apexLogSource.js";
import { operationName } from "./operations.js";

/**
 * What the query optimiser decided, without saying which query it decided about.
 *
 * `relativeCost` is the figure and the verdict is the caller's: above 1 the
 * optimiser will not treat the query as selective. `sObjectType` is not
 * reported — it is in the query text.
 */
export interface QueryPlanVerdict {
  leadingOperationType: string;
  relativeCost: number;
  /** Records the leading operation is expected to return. */
  cardinality: number;
  /** Records the object holds, as the optimiser estimates it. */
  sObjectCardinality: number;
}

/** A verdict beside the query text it was reached for, which keys it. */
export interface QueryPlan extends QueryPlanVerdict {
  name: string;
}

/**
 * The plan the optimiser explained for a query, if it explained one.
 *
 * The explain line is a direct child of the query it explains, so the two are
 * correlated structurally rather than by line number. Its fields are parsed
 * together or not at all, so one unparsed field means no readable plan.
 */
export function planOf(node: LogEvent): QueryPlan | undefined {
  const explain = node.children?.find(
    (child): child is SOQLExecuteExplainLine =>
      child.type === "SOQL_EXECUTE_EXPLAIN",
  );
  if (!explain) {
    return undefined;
  }

  const { leadingOperationType, relativeCost, cardinality, sObjectCardinality } =
    explain;
  if (
    leadingOperationType === null ||
    relativeCost === null ||
    cardinality === null ||
    sObjectCardinality === null
  ) {
    return undefined;
  }

  return {
    name: operationName(node),
    leadingOperationType,
    relativeCost,
    cardinality,
    sObjectCardinality,
  };
}

/**
 * The query plans the log explained, by the name the ranked rows use.
 *
 * `SOQL_EXECUTE_EXPLAIN` is emitted at `DB,FINEST` alone, so an empty result
 * says nothing about how selective the queries were; the response's `dbLevel`
 * says whether one could have been recorded.
 *
 * One query text can be explained more than once, and the worst plan is kept:
 * the caller is looking for the query to fix, and a plan that was selective on
 * one call does not make it selective.
 */
export function listQueryPlans(apexLog: ApexLog): Map<string, QueryPlan> {
  const plans = new Map<string, QueryPlan>();

  apexLog.children.forEach((child) =>
    walkLog<void>(child, (node) => {
      if (node.type !== "SOQL_EXECUTE_BEGIN") {
        return;
      }

      const plan = planOf(node);
      const known = plan && plans.get(plan.name);
      if (plan && (!known || plan.relativeCost > known.relativeCost)) {
        plans.set(plan.name, plan);
      }
    }),
  );

  return plans;
}
