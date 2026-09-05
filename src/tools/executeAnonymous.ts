// First, so the guard runs before the SDK below is evaluated. `src/index.ts`
// guards the `bin` alone, and this module is the entry point of the lazy chunk.
import "../salesforce/logging.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
// This module calls the SDK, so it is reached only through an `await import()`.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { StateAggregator, type Connection } from "@salesforce/core";
import { encode } from "@toon-format/toon";
import { getUserIdByUsername } from "../salesforce/users.js";
import {
  ensureDebugLevel,
  type DebugLevelInput,
  type TraceConfig,
} from "../salesforce/debugLevels.js";
import {
  executeAnonymousWithLog,
  levelsWereOverridden,
} from "../salesforce/anonymousApex.js";
import { ensureTraceFlag } from "../salesforce/traceFlags.js";
import { loadApexLog } from "./apexLogSource.js";
import { NS_TO_MS, roundMs } from "./responseShaping.js";
import { resolveOrg } from "../salesforce/connection.js";
import { toDateTimeLiteral } from "../salesforce/soql.js";
import {
  classifyOrg,
  type OrgClassification,
} from "../salesforce/orgClassification.js";
import {
  apexExecutionRefusal,
  authorizeExecution,
  toolError,
  type ConsumeConfirmation,
  type MintConfirmationState,
} from "../policy/orgExecutionPolicy.js";
import type { ExecuteAnonymousArgs } from "./executeAnonymousDefinition.js";

/** Connect, set the trace flag, execute, write. */
const PROGRESS_STEPS = 4;

/** How far this machine's clock and the org's are allowed to differ. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const NO_LOG_CAPTURED_WARNING =
  "Salesforce returned no debug log for this run, so the saved file is empty and durationMs is 0. A live Developer Console trace flag, or a trace flag the org refused, can take the log away.";

export type ExecuteAnonymousPolicy = {
  allowProductionOrgs: boolean;
  apexExecutionDisabled: boolean;
  classificationCache: Map<string, OrgClassification>;
  mintConfirmationState: MintConfirmationState;
  consumeConfirmation: ConsumeConfirmation;
};

async function getRootPaths(server: McpServer): Promise<string[]> {
  try {
    const { roots } = await server.server.listRoots();
    return roots.map((root) => new URL(root.uri).pathname);
  } catch {
    return [];
  }
}

/** The resolved path, or the path itself when it does not resolve. */
async function realPathOrSelf(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

/**
 * The MCP spec expects a server to work inside the roots the client declares,
 * and `outputDir` is agent-supplied, so it is the path an injected instruction
 * takes. Refusing would break a caller who means to write elsewhere, so say so
 * instead: the response names where the log went, and the same line goes to
 * stderr for the person watching the server.
 *
 * Symlinks are followed on both sides, so a link inside a root that points out
 * of one is still outside. A client that declares no roots gives nothing to
 * compare against, so it stays silent.
 */
async function warnIfOutsideRoots(
  outputDir: string,
  rootPaths: string[],
): Promise<string | undefined> {
  if (rootPaths.length === 0) {
    return undefined;
  }

  const target = await realPathOrSelf(outputDir);
  const roots = await Promise.all(rootPaths.map(realPathOrSelf));
  const inside = roots.some(
    (root) => target === root || target.startsWith(root + path.sep),
  );
  if (inside) {
    return undefined;
  }

  const warning = `Debug log written to ${target}, which is outside every root this client declared.`;
  console.error(`[apex-log-mcp] ${warning}`);
  return warning;
}

async function getAliasForUsername(
  username: string,
): Promise<string | undefined> {
  const stateAggregator = await StateAggregator.getInstance();
  return stateAggregator.aliases.get(username) ?? undefined;
}

export async function executeAnonymous(
  server: McpServer,
  args: ExecuteAnonymousArgs,
  ctx: ServerContext,
  policy: ExecuteAnonymousPolicy,
) {
  const { apex, targetOrg, debugLevel } = args;

  // Short-circuit before touching the client or the org, so a server running with
  // --no-apex-execution makes no Salesforce calls at all. `src/server.ts` asks
  // the same question before it loads this module; this stands for a direct
  // caller.
  const refused = apexExecutionRefusal(policy.apexExecutionDisabled);
  if (refused) {
    return refused;
  }

  const report = progressReporter(ctx);
  const rootPaths = await getRootPaths(server);
  const projectPath = rootPaths[0];

  await report("Connecting to the org");
  const org = await resolveOrg(projectPath, targetOrg);
  const connection = org.getConnection();

  const username = connection.getUsername();
  if (!username) {
    throw new Error("Could not determine username from connection");
  }

  const alias = await getAliasForUsername(username);
  const orgLabel = alias ? `${username} (${alias})` : username;

  // Authorize before creating any DebugLevel or TraceFlag records, so a refused
  // call leaves the target org untouched.
  const { classification, unverifiedReason } = await classifyOrg(
    org,
    policy.classificationCache,
  );
  const decision = await authorizeExecution({
    ctx,
    mintConfirmationState: policy.mintConfirmationState,
    consumeConfirmation: policy.consumeConfirmation,
    classification,
    orgId: org.getOrgId(),
    orgLabel,
    apex,
    allowProductionOrgs: policy.allowProductionOrgs,
    unverifiedReason,
  });

  if (decision.outcome === "confirmationRequired") {
    return decision.result;
  }

  if (decision.outcome === "refused") {
    return toolError(decision.reason);
  }

  await report("Setting the trace flag");
  const userId = await getUserIdByUsername(connection, username);
  const levels = await ensureTracing(connection, userId, debugLevel);

  await report("Executing the Apex");
  const startedAt = new Date();
  const apexResult = await executeAnonymousWithLog(connection, apex, levels);

  if (!apexResult.compiled) {
    throw new Error(
      `Apex could not be compiled at line ${apexResult.line}, column ${apexResult.column}: ${apexResult.compileProblem}`,
    );
  }

  await report("Writing the debug log");

  // Absolute, because `filePath` below goes straight back to the analysis
  // tools, which refuse a relative path. A relative `outputDir` anchors to the
  // project root, the same base the default uses, rather than to wherever the
  // client happened to spawn this server.
  const outputDir = path.resolve(
    projectPath ?? process.cwd(),
    args.outputDir ?? ".apex-log-mcp",
  );
  // Resolves to the first directory created, or undefined when it already existed.
  const createdDir = await fs.mkdir(outputDir, { recursive: true });

  const logId = await findStoredLogId(
    connection,
    userId,
    apexResult.debugLog,
    startedAt,
  );
  const filePath = await writeDebugLog(outputDir, logId, apexResult.debugLog);
  const stats = await fs.stat(filePath);
  // The log itself is the one source of its duration, so this figure and
  // `apexlog_get_summary.durationTotalMs` are the same number. Parsing it here
  // also warms the cache the analysis tools read. An empty log is not parsed:
  // there is no duration to read out of it, and no cache worth warming.
  const parsedLog = apexResult.debugLog
    ? await loadApexLog(filePath)
    : undefined;

  const warnings = [
    // Said outright, because an empty file and a zero duration otherwise read
    // as a run that did nothing rather than a log that was never captured.
    apexResult.debugLog ? undefined : NO_LOG_CAPTURED_WARNING,
    // Only for a caller-given directory: the default is inside the project root
    // by construction, so checking it could only ever say the obvious.
    args.outputDir
      ? await warnIfOutsideRoots(outputDir, rootPaths)
      : undefined,
  ].filter((text): text is string => text !== undefined);

  return {
    content: [
      {
        type: "text" as const,
        text: encode({
          filePath,
          ...(warnings.length && { warning: warnings.join(" ") }),
          fileSizeBytes: stats.size,
          org: orgLabel,
          orgType: classification,
          succeeded: apexResult.succeeded,
          ...(apexResult.exceptionMessage && {
            exceptionMessage: apexResult.exceptionMessage,
          }),
          durationMs: parsedLog
            ? roundMs(parsedLog.duration.total / NS_TO_MS)
            : 0,
          // True when a Developer Console trace flag outranked the levels asked
          // for, which is the one thing that can silently change what was
          // captured. Reported either way, for the same reason as below.
          levelsOverridden: levelsWereOverridden(levels, apexResult.debugLog),
          // A fact about this run, not advice about it: the directory is new, so
          // nothing yet ignores it. Reported either way, because an absent field
          // cannot be told apart from one this server never worked out.
          outputDirCreated: Boolean(createdDir),
        }),
      },
    ],
  };
}

/**
 * Keep the org's trace flag current and report the levels it carries.
 *
 * The flag governs every other transaction this user runs; this call's own log
 * comes from the debug header, which asks for the same levels.
 */
async function ensureTracing(
  connection: Connection,
  userId: string,
  debugLevel?: DebugLevelInput,
): Promise<Required<TraceConfig>> {
  const { id, levels } = await ensureDebugLevel(connection, debugLevel);
  await ensureTraceFlag(connection, userId, id);
  return levels;
}

/**
 * Write the log out, under the id Salesforce filed it as when there is one,
 * and never over a file already there: the id is matched rather than given, so
 * a wrong match must cost a filename and not an earlier run's log.
 */
async function writeDebugLog(
  outputDir: string,
  logId: string | undefined,
  debugLog: string,
): Promise<string> {
  const fallbackPath = path.join(outputDir, `apex-${Date.now()}.log`);
  if (logId) {
    const filePath = path.join(outputDir, `${logId}.log`);
    try {
      await fs.writeFile(filePath, debugLog, { encoding: "utf-8", flag: "wx" });
      return filePath;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      console.error(
        `[apex-log-mcp] ${filePath} already holds a log, so this run was written to ${fallbackPath} instead.`,
      );
    }
  }
  await fs.writeFile(fallbackPath, debugLog, "utf-8");
  return fallbackPath;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/**
 * The id Salesforce filed this log under, matched on its byte length and on
 * having been filed no earlier than this run.
 *
 * Salesforce hands out no log id for anonymous Apex, so this only names the
 * file the way `sf` names it. A miss costs a filename and nothing else, which
 * is why the length is matched rather than the newest row taken, and why a
 * failed query is reported and stepped over: the log is already in hand and
 * cannot be fetched again. Without the time bound, a log of the same length
 * from any earlier run answers the query.
 */
async function findStoredLogId(
  connection: Connection,
  userId: string,
  debugLog: string,
  startedAt: Date,
): Promise<string | undefined> {
  // `StartTime` is org time and `startedAt` is this machine's, so the bound is
  // slackened by the clock skew the two can carry between them.
  const since = new Date(startedAt.getTime() - CLOCK_SKEW_MS);
  try {
    const record = (await connection
      .sobject("ApexLog")
      .findOne(
        {
          LogUserId: userId,
          LogLength: Buffer.byteLength(debugLog, "utf-8"),
          StartTime: { $gte: toDateTimeLiteral(since) },
        },
        ["Id"],
        { sort: { StartTime: -1 } },
      )) as { Id: string } | null;
    return record?.Id;
  } catch (error) {
    console.error(
      `[apex-log-mcp] Could not match the debug log to a stored ApexLog: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Report each step, but only to a caller that asked for progress. The spec
 * gives a token only when it wants the notifications.
 *
 * A failed notification is reported and stepped over. The Apex has already run
 * by the last step, so a rejected notify must not throw away the log it just
 * produced.
 */
function progressReporter(ctx: ServerContext): (step: string) => Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message: string) => {
    if (progressToken === undefined) {
      return;
    }
    progress += 1;
    try {
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress, total: PROGRESS_STEPS, message },
      });
    } catch (error) {
      console.error(
        `[apex-log-mcp] Could not report progress: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
