// This module is the entry point of the lazy chunk, so the guard travels with
// it - `src/index.ts` covers the `bin` alone.
import "../salesforce/logging.js";
import { promises as fs, constants as fsConstants } from "node:fs";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Connection } from "@salesforce/core";
import {
  DEFAULT_TRACE_CONFIG,
  ensureDebugLevel,
  levelsClause,
  requestedLevels,
  type DebugLevelInput,
  type TraceConfig,
} from "../salesforce/debugLevels.js";
import {
  executeAnonymousWithLog,
  levelsWereOverridden,
} from "../salesforce/anonymousApex.js";
import {
  createTraceFlag,
  deleteTraceFlag,
  findActiveTraceFlags,
  findUsersByUsername,
  traceFlagWindow,
  type ActiveTraceFlags,
} from "../salesforce/traceFlags.js";
import { loadApexLog } from "./apexLogSource.js";
import { progressReporter } from "./progress.js";
import { fileReadError, outsideRoots } from "./localFile.js";
import { openLogStore, writeDebugLog } from "./logStore.js";
import { NS_TO_MS, roundMs, toonResult } from "./responseShaping.js";
import { findStoredLogId } from "../salesforce/apexLogs.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import {
  apexExecutionRefusal,
  toolError,
  type Confirmable,
} from "../policy/orgExecutionPolicy.js";
import type { ExecuteAnonymousArgs } from "./executeAnonymousDefinition.js";

/** Connect, set the trace flag, execute, write. */
const PROGRESS_STEPS = 4;

/** Above this, a dialog is too long to read whole, so the confirmation is refused rather than cut. */
export const MAX_APEX_TO_CONFIRM = 10_000;

// Outlives a long run plus the clock skew; the flag is deleted once the id is matched.
const RUN_TRACE_FLAG_MS = 15 * 60 * 1000;

const ONE_APEX_SOURCE =
  "Give exactly one of apex and apexFilePath: the Apex inline, or the absolute path to a file of it.";

const NO_LOG_CAPTURED_WARNING =
  "Salesforce returned no debug log for this run, so the saved file is empty and durationMs is 0. A live Developer Console trace flag, or a trace flag the org refused, can take the log away.";

export type ExecuteAnonymousPolicy = OrgAccessPolicy & {
  apexExecutionDisabled: boolean;
};

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

/** Where a run's levels came from: the user's trace flag, the defaults, the call, or a Developer Console flag. */
type LevelsSource = "traceFlag" | "default" | "request" | "developerConsole";

type RunLevels = { levels: Required<TraceConfig>; source: LevelsSource };

const SOURCE_TEXT: Record<LevelsSource, string> = {
  traceFlag: "your trace flag's",
  default: "the defaults",
  request: "as requested",
  developerConsole: "your Developer Console trace flag's",
};

// A Developer Console flag outranks the header (.claude/rules/trace-flags.md), so its levels are the ones confirmed and run.
function resolveRunLevels(
  debugLevel: DebugLevelInput | undefined,
  flags: ActiveTraceFlags,
  username: string,
): RunLevels {
  // First, so a bad debugLevel or a missing USER_DEBUG flag is refused even when the console wins.
  const asked = askedLevels(debugLevel, flags.userDebugLevels, username);
  return flags.developerConsoleLevels
    ? { levels: flags.developerConsoleLevels, source: "developerConsole" }
    : asked;
}

// Read from the flag and sent, not left to it: with no header the returned log is empty.
function askedLevels(
  debugLevel: DebugLevelInput | undefined,
  userDebugLevels: Required<TraceConfig> | undefined,
  username: string,
): RunLevels {
  if (debugLevel === "default") {
    return { levels: DEFAULT_TRACE_CONFIG, source: "default" };
  }
  if (debugLevel !== undefined && debugLevel !== "traceFlag") {
    return { levels: requestedLevels(debugLevel), source: "request" };
  }
  if (userDebugLevels !== undefined) {
    return { levels: userDebugLevels, source: "traceFlag" };
  }
  // Asked for by name, so a flag that has expired is said, not papered over with the defaults.
  if (debugLevel === "traceFlag") {
    throw new Error(
      `${username} has no active USER_DEBUG trace flag, so there are no levels to use. Create one, or leave out debugLevel to run at the defaults.`,
    );
  }
  return { levels: DEFAULT_TRACE_CONFIG, source: "default" };
}

// All of it, never cut, between markers and with its size, so Apex cannot pass for the end of the prompt.
function apexConfirmable(
  apex: string,
  run: RunLevels,
  orgLabel: string,
): Confirmable {
  const lines = apex.split("\n").length;
  const linesText = `${lines} line${lines === 1 ? "" : "s"}`;
  const clause = levelsClause(run.levels);
  return {
    // The levels, not where they came from, so a flag that expires to the same levels keeps the confirmation.
    effect: `${clause}\0${apex}`,
    // Before the Apex, so the Apex cannot pass for it.
    detail: `Log levels, ${SOURCE_TEXT[run.source]}: ${clause}.\n\nApex, ${linesText} and ${apex.length} characters:\n----- BEGIN APEX -----\n${apex}\n----- END APEX -----`,
    // The size again, in the schema, where the Apex cannot reach.
    title: `Run ${linesText} of Apex`,
    unshowable:
      apex.length > MAX_APEX_TO_CONFIRM
        ? `The Apex is ${apex.length} characters, more than the ${MAX_APEX_TO_CONFIRM} a confirmation shows whole, ` +
          `so nothing was executed against '${orgLabel}'. To run it, restart the server with --allow-production-orgs.`
        : undefined,
  };
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

  const report = progressReporter(ctx, PROGRESS_STEPS);
  const access = await openOrg(
    server,
    ctx,
    {
      tool: "apexlog_execute_anonymous",
      action: "execute anonymous Apex",
      targetOrg,
      report,
      unknownRoots: (reason) =>
        args.apexFilePath !== undefined
          ? `Cannot check Apex file ${args.apexFilePath}: ${reason}. Pass the Apex inline in apex.`
          : undefined,
      prepare: readApex,
      write: async ({ value: apex, connection, local, orgLabel }) => {
        const [user] = await findUsersByUsername(connection, local.username);
        if (!user) {
          throw new Error(`No user in this org has the username ${local.username}.`);
        }
        const userId = user.id;
        // A live flag may be a concurrent run's, deleted before this one ends: then only the log id is lost.
        const flags = await findActiveTraceFlags(connection, userId);
        const run = resolveRunLevels(debugLevel, flags, local.username);
        return {
          value: { apex, userId, storesLogs: flags.storesLogs, run },
          confirm: apexConfirmable(apex, run, orgLabel),
        };
      },
    },
    policy,
  );
  // Before any DebugLevel or TraceFlag is written, so a refused call leaves the org untouched.
  if (!access.granted) {
    return access.result;
  }
  const {
    value: { apex, userId, storesLogs, run },
    connection,
    orgLabel,
    classification,
    workspace,
    rootPaths,
  } = access;

  await report("Setting the trace flag");
  const debugLevelId = storesLogs
    ? undefined
    : await ensureDebugLevel(connection);

  const {
    value: { apexResult, logId },
    warnings: traceFlagWarnings,
  } = await withTraceFlagForRun(
    connection,
    userId,
    debugLevelId,
    async (flagLive) => {
      await report("Executing the Apex");
      const startedAt = new Date();
      const apexResult = await executeAnonymousWithLog(
        connection,
        apex,
        run.levels,
      );

      if (!apexResult.compiled) {
        throw new Error(
          `Apex could not be compiled at line ${apexResult.line}, column ${apexResult.column}: ${apexResult.compileProblem}`,
        );
      }

      // An empty log has nothing stored to match. Without our flag, another may have stored it, so even one match is checked.
      const logId = apexResult.debugLog
        ? await findStoredLogId(
            connection,
            userId,
            apexResult.debugLog,
            startedAt,
            !flagLive,
          )
        : undefined;
      return { apexResult, logId };
    },
  );

  await report("Writing the debug log");

  const store = await openLogStore(args.outputDir, workspace, rootPaths);
  const filePath = await writeDebugLog(store.dir, logId, apexResult.debugLog);
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
    store.warning,
  ].filter((text): text is string => text !== undefined);

  return toonResult({
    filePath,
    ...(warnings.length && { warning: warnings.join(" ") }),
    fileSizeBytes: stats.size,
    org: orgLabel,
    orgType: classification,
    succeeded: apexResult.succeeded,
    ...(apexResult.exceptionMessage && {
      exceptionMessage: apexResult.exceptionMessage,
    }),
    durationMs: parsedLog ? roundMs(parsedLog.duration.total / NS_TO_MS) : 0,
    // True when the log carries levels other than the ones levelsSource
    // names - a Developer Console flag set during the run, say. Reported
    // either way, for the same reason as below.
    levelsOverridden: levelsWereOverridden(run.levels, parsedLog?.debugLevels),
    // Where the levels came from, so a log far thinner or fuller than expected explains itself.
    levelsSource: run.source,
    // A fact about this run, not advice about it: the directory is new, so
    // nothing yet ignores it. Reported either way, because an absent field
    // cannot be told apart from one this server never worked out.
    outputDirCreated: store.created,
  });
}

// Only a live flag stores the log the file's id comes from; `flagLevelId` is undefined when the user has one (.claude/rules/trace-flags.md).
async function withTraceFlagForRun<T>(
  connection: Connection,
  userId: string,
  flagLevelId: string | undefined,
  run: (flagLive: boolean) => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const created =
    flagLevelId === undefined
      ? {}
      : await createRunTraceFlag(connection, userId, flagLevelId);

  let value: T;
  let deleteWarning: string | undefined;
  try {
    value = await run(flagLevelId === undefined || created.id !== undefined);
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
        traceFlagWindow(RUN_TRACE_FLAG_MS),
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
