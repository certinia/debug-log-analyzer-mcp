// This module is the entry point of the lazy chunk, so the guard travels with
// it - `src/index.ts` covers the `bin` alone.
import "../salesforce/logging.js";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import type { Connection } from "@salesforce/core";
import { encode } from "@toon-format/toon";
import { getUserIdByUsername } from "../salesforce/users.js";
import { ensureDebugLevel } from "../salesforce/debugLevels.js";
import {
  executeAnonymousWithLog,
  levelsWereOverridden,
} from "../salesforce/anonymousApex.js";
import {
  createTraceFlag,
  deleteTraceFlag,
  hasActiveTraceFlag,
} from "../salesforce/traceFlags.js";
import { loadApexLog } from "./apexLogSource.js";
import { fileReadError } from "./localFile.js";
import { NS_TO_MS, roundMs } from "./responseShaping.js";
import { connectOrg, readLocalOrg } from "../salesforce/connection.js";
import { CLOCK_SKEW_MS, toDateTimeLiteral } from "../salesforce/soql.js";
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
import {
  identityRefusal,
  typeRefusal,
  type DenyList,
} from "../policy/orgDenyList.js";
import type { ExecuteAnonymousArgs } from "./executeAnonymousDefinition.js";

/** Connect, set the trace flag, execute, write. */
const PROGRESS_STEPS = 4;

const ROOTS_TIMEOUT_MS = 5_000;

// Outlives a long run plus the clock skew; the flag is deleted once the id is matched.
const RUN_TRACE_FLAG_MS = 15 * 60 * 1000;

const ONE_APEX_SOURCE =
  "Give exactly one of apex and apexFilePath: the Apex inline, or the absolute path to a file of it.";

const NO_LOG_CAPTURED_WARNING =
  "Salesforce returned no debug log for this run, so the saved file is empty and durationMs is 0. A live Developer Console trace flag, or a trace flag the org refused, can take the log away.";

export type ExecuteAnonymousPolicy = {
  allowProductionOrgs: boolean;
  denyList: DenyList;
  apexExecutionDisabled: boolean;
  classificationCache: Map<string, OrgClassification>;
  mintConfirmationState: MintConfirmationState;
  consumeConfirmation: ConsumeConfirmation;
};

async function getRootPaths(
  server: McpServer,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    // Bounded, so a client that never answers costs seconds, not the SDK's 60 s default.
    const { roots } = await server.server.listRoots(undefined, {
      timeout: ROOTS_TIMEOUT_MS,
      signal,
    });
    // fileURLToPath decodes `%20` and drops the slash before a Windows drive, which `pathname` keeps.
    return roots
      .filter((root) => root.uri.startsWith("file:"))
      .map((root) => fileURLToPath(root.uri));
  } catch (error) {
    // A cancelled call stops here, rather than running on with no roots.
    if (signal.aborted) {
      throw error;
    }
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
  const target = await outsideRoots(outputDir, rootPaths);
  if (target === undefined) {
    return undefined;
  }

  const warning = `Debug log written to ${target}, which is outside every root this client declared.`;
  console.error(`[apex-log-mcp] ${warning}`);
  return warning;
}

/** `target` with symlinks followed when it is outside every root, else undefined. No roots, no check. */
async function outsideRoots(
  target: string,
  rootPaths: string[],
): Promise<string | undefined> {
  if (rootPaths.length === 0) {
    return undefined;
  }

  const resolved = await realPathOrSelf(target);
  const roots = await Promise.all(rootPaths.map(realPathOrSelf));
  const inside = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  return inside ? undefined : resolved;
}

// Refused where `outputDir` only warns: the file's text goes to the org, and a compile error can echo it.
async function readApexFile(
  apexFilePath: string,
  rootPaths: string[],
): Promise<string> {
  const outside = await outsideRoots(apexFilePath, rootPaths);
  if (outside !== undefined) {
    throw new Error(
      `Apex file ${outside} is outside every root this client declared.`,
    );
  }

  // One handle for the check and the read, as in `loadApexLog`; O_NONBLOCK so a FIFO cannot block the open.
  let handle;
  let text;
  try {
    handle = await fs.open(
      apexFilePath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    );
    if ((await handle.stat()).isFile()) {
      text = await handle.readFile("utf8");
    }
  } catch (error) {
    throw fileReadError("Apex file", apexFilePath, error);
  } finally {
    await handle?.close();
  }
  // A device reads without end, and a FIFO would block the one stdio process.
  if (text === undefined) {
    throw new Error(
      `Cannot read Apex file ${apexFilePath}: not a regular file`,
    );
  }
  // Salesforce fails a leading byte order mark at line 1, column 1.
  return text.replace(/^\uFEFF/, "");
}

// A function, so the file is read only once the org passes the identity deny.
function apexSource({
  apex,
  apexFilePath,
}: ExecuteAnonymousArgs): ((rootPaths: string[]) => Promise<string>) | undefined {
  if (apex !== undefined && apexFilePath === undefined) {
    return async () => apex;
  }
  if (apexFilePath !== undefined && apex === undefined) {
    return (rootPaths) => readApexFile(apexFilePath, rootPaths);
  }
  return undefined;
}

export async function executeAnonymous(
  server: McpServer,
  args: ExecuteAnonymousArgs,
  ctx: ServerContext,
  policy: ExecuteAnonymousPolicy,
) {
  const { targetOrg, debugLevel } = args;

  // Short-circuit before touching the client or the org, so a server running with
  // --no-apex-execution makes no Salesforce calls at all. `src/server.ts` asks
  // the same question before it loads this module; this stands for a direct
  // caller.
  const refused = apexExecutionRefusal(policy.apexExecutionDisabled);
  if (refused) {
    return refused;
  }

  const readApex = apexSource(args);
  if (!readApex) {
    return toolError(ONE_APEX_SOURCE);
  }

  const report = progressReporter(ctx);
  const rootPaths = await getRootPaths(server, ctx.mcpReq.signal);
  const projectPath = rootPaths[0];

  const local = await readLocalOrg(projectPath, targetOrg);
  const { orgId, username } = local;
  const alias = local.aliases[0];
  const orgLabel = alias ? `${username} (${alias})` : username;

  // Before connecting, because Org.create can call the org.
  const deniedUnseen = identityRefusal(policy.denyList, orgLabel, local);
  if (deniedUnseen) {
    return toolError(deniedUnseen);
  }

  // Before connecting, so a bad path costs no call to the org.
  const apex = await readApex(rootPaths);

  await report("Connecting to the org");
  const org = await connectOrg(local);
  const connection = org.getConnection();

  // Authorize before creating any DebugLevel or TraceFlag records, so a refused
  // call leaves the target org untouched.
  const { classification, unverifiedReason } = await classifyOrg(
    org,
    policy.classificationCache,
  );
  // Before authorizeExecution, so no flag and no confirmation can lift it.
  const deniedType = typeRefusal(policy.denyList, orgLabel, classification);
  if (deniedType) {
    return toolError(deniedType);
  }
  const decision = await authorizeExecution({
    ctx,
    mintConfirmationState: policy.mintConfirmationState,
    consumeConfirmation: policy.consumeConfirmation,
    classification,
    orgId,
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
  // A live flag may be a concurrent run's, deleted before this one ends: then only the log id is lost.
  const [{ id: debugLevelId, levels }, alreadyTraced] = await Promise.all([
    ensureDebugLevel(connection, debugLevel),
    hasActiveTraceFlag(connection, userId),
  ]);

  const {
    value: { apexResult, logId },
    warnings: traceFlagWarnings,
  } = await withTraceFlagForRun(
    connection,
    userId,
    alreadyTraced ? undefined : debugLevelId,
    async () => {
      await report("Executing the Apex");
      const startedAt = new Date();
      const apexResult = await executeAnonymousWithLog(
        connection,
        apex,
        levels,
      );

      if (!apexResult.compiled) {
        throw new Error(
          `Apex could not be compiled at line ${apexResult.line}, column ${apexResult.column}: ${apexResult.compileProblem}`,
        );
      }

      const logId = await findStoredLogId(
        connection,
        userId,
        apexResult.debugLog,
        startedAt,
      );
      return { apexResult, logId };
    },
  );

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
    ...traceFlagWarnings,
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

// Only a live flag stores the log the file's id comes from; `flagLevelId` is undefined when the user has one (.claude/rules/trace-flags.md).
async function withTraceFlagForRun<T>(
  connection: Connection,
  userId: string,
  flagLevelId: string | undefined,
  run: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const created =
    flagLevelId === undefined
      ? {}
      : await createRunTraceFlag(connection, userId, flagLevelId);

  let value: T;
  let deleteWarning: string | undefined;
  try {
    value = await run();
  } finally {
    deleteWarning = await removeRunTraceFlag(connection, created.id);
  }
  return {
    value,
    warnings: [created.warning, deleteWarning].filter(
      (warning): warning is string => warning !== undefined,
    ),
  };
}

// A refused flag costs only the file's log id, so the run goes on and says so.
async function createRunTraceFlag(
  connection: Connection,
  userId: string,
  debugLevelId: string,
): Promise<{ id?: string; warning?: string }> {
  try {
    return {
      id: await createTraceFlag(
        connection,
        userId,
        debugLevelId,
        RUN_TRACE_FLAG_MS,
      ),
    };
  } catch (error) {
    const warning = `Could not set a trace flag for this run, so the org may not store its log and the file may be named by time, not log id: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[apex-log-mcp] ${warning}`);
    return { warning };
  }
}

// Reported, not thrown: the log is in hand and the flag expires on its own.
async function removeRunTraceFlag(
  connection: Connection,
  traceFlagId: string | undefined,
): Promise<string | undefined> {
  if (traceFlagId === undefined) {
    return undefined;
  }
  try {
    await deleteTraceFlag(connection, traceFlagId);
    return undefined;
  } catch (error) {
    const warning = `Could not delete trace flag ${traceFlagId}, created for this run; it expires within ${RUN_TRACE_FLAG_MS / 60_000} minutes.`;
    console.error(
      `[apex-log-mcp] ${warning} ${error instanceof Error ? error.message : String(error)}`,
    );
    return warning;
  }
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
