import type { Connection } from "@salesforce/core";
import {
  DEBUG_LEVEL_FIELDS,
  DEBUG_LEVEL_NAME,
  levelsClause,
  toTraceConfig,
  type TraceConfig,
} from "./debugLevels.js";
import { saveErrorText, savedOutcome, thrownOutcome, type DeleteResult } from "./deleteResults.js";
import { mapRequests } from "./parallelRequests.js";
import {
  CLOCK_SKEW_MS,
  isIdShaped,
  isoSeconds,
  isSalesforceId,
  quote,
  toDateTimeLiteral,
  toLongId,
} from "./soql.js";

const TRACE_FLAG_SOBJECT = "TraceFlag";

/**
 * The most flags one query returns, and so the most ids a name lookup or a
 * delete names: an `Id IN` list this long stays well inside the URI length a
 * GET allows.
 */
export const IDS_PER_QUERY = 200;

// A Developer Console flag stores the user's logs too - see .claude/rules/trace-flags.md.
const STORING_LOG_TYPES = ["USER_DEBUG", "DEVELOPER_LOG"];

/** The flag's DebugLevel: its name, then the fields that hold its levels. */
const DEBUG_LEVEL_SELECT = ["DeveloperName", ...DEBUG_LEVEL_FIELDS]
  .map((field) => `DebugLevel.${field}`)
  .join(", ");

/** The entity's flags live now: whether one stores its logs, and the levels of each kind. */
export type ActiveTraceFlags = {
  storesLogs: boolean;
  /** Undefined when only a Developer Console flag, or none, is live. */
  userDebugLevels?: Required<TraceConfig>;
  /** The Developer Console flag's, which outrank every other; undefined when none is live. */
  developerConsoleLevels?: Required<TraceConfig>;
};

/**
 * The entity's live flags, with the levels of the debug level each points at,
 * in one query. At most one `USER_DEBUG` flag is live at a time, because
 * Salesforce refuses one whose window overlaps another.
 */
export async function findActiveTraceFlags(
  connection: Connection,
  tracedEntityId: string,
): Promise<ActiveTraceFlags> {
  const now = toDateTimeLiteral(new Date());
  const { records } = await connection.tooling.query<{
    LogType: string;
    DebugLevel: Record<string, unknown> | null;
  }>(
    `SELECT LogType, ${DEBUG_LEVEL_SELECT}
     FROM ${TRACE_FLAG_SOBJECT}
     WHERE TracedEntityId = ${quote(tracedEntityId)}
       AND (StartDate = null OR StartDate <= ${now}) AND ExpirationDate > ${now}
       AND LogType IN (${STORING_LOG_TYPES.map(quote).join(", ")})`,
  );
  // A run's own flag, still live or left by a failed delete, stores the log but is not the user's choice of levels.
  const userDebug = records.find(
    (flag) =>
      flag.LogType === "USER_DEBUG" &&
      flag.DebugLevel?.["DeveloperName"] !== DEBUG_LEVEL_NAME,
  );
  const developerConsole = records.find(
    (flag) => flag.LogType === "DEVELOPER_LOG",
  );
  return {
    storesLogs: records.length > 0,
    userDebugLevels: userDebug && toTraceConfig(userDebug.DebugLevel),
    developerConsoleLevels:
      developerConsole && toTraceConfig(developerConsole.DebugLevel),
  };
}

/** Salesforce refuses a flag whose window, from its StartDate, runs 24 hours or more. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The longest flag a call can ask for, a minute short of the day. */
export const MAX_DURATION_MINUTES = MAX_WINDOW_MS / 60_000 - 1;

/** When a flag starts and expires. */
export type TraceFlagWindow = { start: Date; end: Date };

/**
 * When a flag live for `durationMs` from now starts and ends, to the second.
 * It starts back by the clock skew, so an org clock behind this one still sees
 * it live, but never so far back that the window reaches a day, nor before
 * `notBefore`.
 */
export function traceFlagWindow(
  durationMs: number,
  notBefore?: Date,
): TraceFlagWindow {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const back = Math.min(CLOCK_SKEW_MS, MAX_WINDOW_MS - durationMs - 1000);
  return {
    start: new Date(Math.max(now - back, notBefore?.getTime() ?? 0)),
    end: new Date(now + durationMs),
  };
}

/**
 * Create a flag live for `window`, `USER_DEBUG` unless told otherwise, and
 * return its id. Salesforce refuses it when the entity has a flag of the same
 * log type whose window overlaps, live or not.
 */
export async function createTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string,
  window: TraceFlagWindow,
  logType: TraceLogType = "USER_DEBUG",
): Promise<string> {
  const result = await connection.tooling.sobject(TRACE_FLAG_SOBJECT).create({
    TracedEntityId: tracedEntityId,
    DebugLevelId: debugLevelId,
    StartDate: window.start.toISOString(),
    ExpirationDate: window.end.toISOString(),
    LogType: logType,
  });

  if (!result.success) {
    throw new Error(`Salesforce refused the trace flag: ${saveErrorText(result.errors)}`);
  }
  if (!result.id) {
    throw new Error("Salesforce saved the trace flag but returned no id.");
  }

  return result.id;
}

/**
 * Delete trace flags, one request each, a failure kept beside its id. Once
 * `signal` aborts, no further flag is sent, and the call rejects.
 */
export async function destroyTraceFlags(
  connection: Connection,
  ids: string[],
  signal?: AbortSignal,
): Promise<DeleteResult[]> {
  const results = await mapRequests(ids, async (id): Promise<DeleteResult[]> => {
    // Returns, not throws, so the pool waits for the requests in flight before the call rejects.
    if (signal?.aborted) {
      return [];
    }
    try {
      const result = await connection.tooling.sobject(TRACE_FLAG_SOBJECT).destroy(id);
      return [{ id, ...savedOutcome(result) }];
    } catch (error) {
      return [{ id, ...thrownOutcome(error) }];
    }
  });
  signal?.throwIfAborted();
  return results.flat();
}

/** A user is traced as `USER_DEBUG`; a class or a trigger as `CLASS_TRACING`. */
export type TraceLogType = "USER_DEBUG" | "CLASS_TRACING";

type EntityType = "User" | "ApexClass" | "ApexTrigger";

/** What a flag traces: a user, a class or a trigger, by the name a person knows it by. */
export type TracedEntity = {
  id: string;
  /** The username for a user; `ns.Name`, or `Name`, for a class or trigger. */
  name: string;
  type: EntityType;
};

// By id prefix, since the org sends a class's key prefix as its TracedEntity.Type.
const ENTITY_TYPES: Record<string, { type: EntityType; soql: string; tooling: boolean }> = {
  "005": { type: "User", soql: "SELECT Id, Username FROM User", tooling: false },
  "01p": { type: "ApexClass", soql: "SELECT Id, Name, NamespacePrefix FROM ApexClass", tooling: true },
  "01q": { type: "ApexTrigger", soql: "SELECT Id, Name, NamespacePrefix FROM ApexTrigger", tooling: true },
};

/** A trace flag, as the tools report it. */
export type TraceFlagRow = {
  id: string;
  tracedEntity: string;
  entityType: string;
  logType: string;
  /** The DebugLevel record's name; `levels` are what it sets. */
  debugLevelName: string;
  levels: string;
  startTime: string;
  expirationTime: string;
};

type EntityRecord = {
  Id: string;
  Username?: string;
  Name?: string;
  NamespacePrefix?: string | null;
};

// A user by username, and a class or trigger by its name with its namespace, as resolveTracedEntity takes them back.
function entityName(record: EntityRecord): string {
  return (
    record.Username ??
    (record.NamespacePrefix
      ? `${record.NamespacePrefix}.${record.Name}`
      : (record.Name ?? record.Id))
  );
}

async function queryEntities(
  connection: Connection,
  prefix: string,
  where: string,
): Promise<TracedEntity[]> {
  // In range: callers pass a prefix ENTITY_TYPES names.
  const { type, soql, tooling } = ENTITY_TYPES[prefix]!;
  const query = `${soql} WHERE ${where}`;
  const { records } = await (tooling
    ? connection.tooling.query<EntityRecord>(query)
    : connection.query<EntityRecord>(query));
  return records.map((record) => ({ id: record.Id, name: entityName(record), type }));
}

/** The users with this username: none, or one, since a username is unique across Salesforce. */
export async function findUsersByUsername(
  connection: Connection,
  username: string,
): Promise<TracedEntity[]> {
  return queryEntities(connection, "005", `Username = ${quote(username)}`);
}

/**
 * The user, class or trigger `name` names: an id, a username, or a class or
 * trigger name, `ns.Name` when namespaced. A bare name prefers the one local
 * to the org. Throws when nothing, or more than one thing, answers to it.
 */
export async function resolveTracedEntity(
  connection: Connection,
  name: string,
): Promise<TracedEntity> {
  const byId = Object.keys(ENTITY_TYPES).find((prefix) =>
    isIdShaped(name, prefix),
  );
  // Shaped as an id, but with a suffix its first 15 characters do not give.
  if (byId && !isSalesforceId(name, byId)) {
    throw new Error(
      `${name} is not a valid id: its last 3 characters do not match its first 15. Pass the 15-character id, or copy the 18-character one again.`,
    );
  }
  const byUsername = name.includes("@");
  const found = byId
    ? await queryEntities(connection, byId, `Id = ${quote(toLongId(name))}`)
    : byUsername
      ? await findUsersByUsername(connection, name)
      : await byName(connection, name);
  if (found.length === 0) {
    throw new Error(
      byId || byUsername
        ? `No user, class or trigger in this org has the ${byUsername ? "username" : "id"} ${name}. Check tracedEntity.`
        : `No user, class or trigger in this org is named ${name}. In tracedEntity, name a user by username or id, and a namespaced class as ns.Name.`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `More than one class or trigger is named ${name}: ${found.map((entity) => `${entity.name} (${entity.type}, ${entity.id})`).join(", ")}. Pass its id as tracedEntity.`,
    );
  }
  // In range: found has exactly one entry here.
  return found[0]!;
}

async function byName(connection: Connection, name: string): Promise<TracedEntity[]> {
  // A namespaced name, ns.Name, matches on both parts; an inner class cannot be traced.
  const [, namespace, local] = /^(?:([^.]+)\.)?([^.]+)$/.exec(name) ?? [];
  if (local === undefined) {
    return [];
  }
  const where = `Name = ${quote(local)}${namespace === undefined ? "" : ` AND NamespacePrefix = ${quote(namespace)}`}`;
  const found = (
    await Promise.all([
      queryEntities(connection, "01p", where),
      queryEntities(connection, "01q", where),
    ])
  ).flat();
  // A bare name reaches the org's own class over a package's of the same name.
  const ownOrg = found.filter((entity) => !entity.name.includes("."));
  return namespace === undefined && ownOrg.length === 1 ? ownOrg : found;
}

/** The log type a flag on this kind of entity takes. */
export function logTypeFor(entity: TracedEntity): TraceLogType {
  return entity.type === "User" ? "USER_DEBUG" : "CLASS_TRACING";
}

// Named by `known`, or looked up, since TracedEntity.Name gives a user's full name, not the username.
async function queryTraceFlags(
  connection: Connection,
  where: string,
  known?: TracedEntity,
): Promise<TraceFlagRow[]> {
  const { records } = await connection.tooling.query<{
    Id: string;
    TracedEntityId: string;
    LogType: string;
    DebugLevel: Record<string, unknown> | null;
    StartDate: string | null;
    CreatedDate: string;
    ExpirationDate: string;
  }>(
    `SELECT Id, TracedEntityId, LogType, ${DEBUG_LEVEL_SELECT}, StartDate, CreatedDate, ExpirationDate
     FROM ${TRACE_FLAG_SOBJECT}
     WHERE ${where}
     ORDER BY ExpirationDate DESC
     LIMIT ${IDS_PER_QUERY}`,
  );
  const names = known
    ? new Map([[known.id, known.name]])
    : await entityNames(connection, records.map((flag) => flag.TracedEntityId));
  return records.map((flag) => ({
    id: flag.Id,
    tracedEntity: names.get(flag.TracedEntityId) ?? flag.TracedEntityId,
    entityType: ENTITY_TYPES[flag.TracedEntityId.slice(0, 3)]?.type ?? "",
    logType: flag.LogType,
    debugLevelName: String(flag.DebugLevel?.["DeveloperName"] ?? ""),
    levels: levelsClause(toTraceConfig(flag.DebugLevel)),
    // A flag set with no StartDate starts when it is created.
    startTime: isoSeconds(flag.StartDate ?? flag.CreatedDate),
    expirationTime: isoSeconds(flag.ExpirationDate),
  }));
}

async function entityNames(
  connection: Connection,
  entityIds: string[],
): Promise<Map<string, string>> {
  // One query per type: queryTraceFlags returns at most IDS_PER_QUERY flags.
  const found = await Promise.all(
    Object.keys(ENTITY_TYPES).map((prefix) => {
      const ids = [...new Set(entityIds.filter((id) => id.startsWith(prefix)))];
      return ids.length
        ? queryEntities(connection, prefix, `Id IN (${ids.map(quote).join(", ")})`)
        : [];
    }),
  );
  return new Map(found.flat().map((entity) => [entity.id, entity.name]));
}

/**
 * The flags not yet expired, on one entity or on all, latest to expire first:
 * the first `IDS_PER_QUERY`, and how many there are in all.
 */
export async function listTraceFlags(
  connection: Connection,
  entity?: TracedEntity,
): Promise<{ flags: TraceFlagRow[]; matchedCount: number }> {
  const now = toDateTimeLiteral(new Date());
  const where = `ExpirationDate > ${now}${entity ? ` AND TracedEntityId = ${quote(entity.id)}` : ""}`;
  const flags = await queryTraceFlags(connection, where, entity);
  // Under the cap, the rows are every match, so only a full page costs a count.
  const matchedCount =
    flags.length < IDS_PER_QUERY
      ? flags.length
      : (
          await connection.tooling.query(
            `SELECT COUNT() FROM ${TRACE_FLAG_SOBJECT} WHERE ${where}`,
          )
        ).totalSize;
  return { flags, matchedCount };
}

/** What a new flag meets: a live flag that blocks it, or the time after which it must start. */
export type TraceFlagOverlap = { live?: TraceFlagRow; notBefore?: Date };

/**
 * The entity's flag of this log type whose window a new one, live for
 * `durationMs`, would overlap: one ending after the new one starts, and
 * starting before it ends; the latest to expire. One that has ended, inside
 * the clock skew the new one starts back by, logs no more, so it only moves
 * the new one's start to just after it.
 */
export async function findOverlappingTraceFlag(
  connection: Connection,
  entity: TracedEntity,
  logType: TraceLogType,
  durationMs: number,
): Promise<TraceFlagOverlap> {
  const window = traceFlagWindow(durationMs);
  const [flag] = await queryTraceFlags(
    connection,
    // A flag set with no StartDate starts when it is created, so it has started.
    `TracedEntityId = ${quote(entity.id)} AND LogType = ${quote(logType)}
       AND ExpirationDate > ${toDateTimeLiteral(window.start)}
       AND (StartDate = null OR StartDate < ${toDateTimeLiteral(window.end)})`,
    entity,
  );
  if (!flag) {
    return {};
  }
  const end = Date.parse(flag.expirationTime);
  return end > Date.now() ? { live: flag } : { notBefore: new Date(end + 1000) };
}

/** The flags with these ids, whether or not they have expired. */
export async function findTraceFlags(
  connection: Connection,
  ids: string[],
): Promise<TraceFlagRow[]> {
  return queryTraceFlags(connection, `Id IN (${ids.map(quote).join(", ")})`);
}
