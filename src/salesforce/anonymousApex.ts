import type { Connection } from "@salesforce/core";

import {
  CATEGORY_LOG_NAMES,
  TRACE_CATEGORIES,
  type LogCategory,
  type LogLevel,
  type TraceConfig,
} from "./debugLevels.js";

const APEX_NAMESPACE = "http://soap.sforce.com/2006/08/apex";

export type AnonymousApexResult = {
  compiled: boolean;
  succeeded: boolean;
  line: number;
  column: number;
  compileProblem?: string;
  exceptionMessage?: string;
  exceptionStackTrace?: string;
  /** The debug log the header asked for, returned with the result. */
  debugLog: string;
};

/**
 * Run anonymous Apex over the SOAP Apex API and take its debug log inline.
 *
 * The REST Tooling API returns no log, which is why the log had to be guessed
 * from the newest `ApexLog` row before. A `DebuggingHeader` outranks any
 * `USER_DEBUG` trace flag, so the levels asked for here are the levels the
 * returned log carries — unless a `DEVELOPER_LOG` flag (the Developer Console)
 * is live, which outranks both.
 */
export async function executeAnonymousWithLog(
  connection: Connection,
  apex: string,
  levels: Required<TraceConfig>,
): Promise<AnonymousApexResult> {
  const response = await postExecuteAnonymous(connection, apex, levels);
  const envelope = asRecord(response["soapenv:Envelope"]);
  const header = asRecord(envelope["soapenv:Header"]);
  const body = asRecord(envelope["soapenv:Body"]);
  const result = asRecord(
    asRecord(body["executeAnonymousResponse"])["result"],
  );

  return {
    compiled: result["compiled"] === "true",
    succeeded: result["success"] === "true",
    line: Number(result["line"] ?? -1),
    column: Number(result["column"] ?? -1),
    ...optionalText("compileProblem", result["compileProblem"]),
    ...optionalText("exceptionMessage", result["exceptionMessage"]),
    ...optionalText("exceptionStackTrace", result["exceptionStackTrace"]),
    debugLog: text(asRecord(header["DebuggingInfo"])["debugLog"]) ?? "",
  };
}

/** The log levels the returned log opens with, as the log spells them. */
export function parseLogHeaderLevels(
  debugLog: string,
): Partial<Record<LogCategory, LogLevel>> {
  const [header = ""] = debugLog.split("\n", 1);
  const entries = header
    .split(";")
    .map((pair) => pair.trim().split(","))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([category, level]) => [
      // The first pair carries the API version — `67.0 APEX_CODE`.
      category.slice(category.lastIndexOf(" ") + 1),
      level,
    ]);
  return Object.fromEntries(entries);
}

/**
 * True when the org logged at levels other than the ones asked for.
 *
 * Only the categories asked for are compared: a log always reports
 * `DATA_ACCESS`, which no `DebugLevel` field can set.
 */
export function levelsWereOverridden(
  requested: Required<TraceConfig>,
  debugLog: string,
): boolean {
  const logged = parseLogHeaderLevels(debugLog);
  return TRACE_CATEGORIES.some((category) => {
    const actual = logged[CATEGORY_LOG_NAMES[category]];
    return actual !== undefined && actual !== requested[category];
  });
}

async function postExecuteAnonymous(
  connection: Connection,
  apex: string,
  levels: Required<TraceConfig>,
): Promise<Record<string, unknown>> {
  const sessionId = connection.accessToken;
  if (!sessionId) {
    throw new Error("The org connection carries no access token.");
  }

  const response = await connection.request({
    method: "POST",
    // The org id prefix of the session id is a required path segment; without
    // it Salesforce rejects the session as illegal.
    url: `${connection.instanceUrl}/services/Soap/s/${connection.version}/${sessionId.split("!")[0]}`,
    body: buildEnvelope(sessionId, apex, levels),
    headers: { "content-type": "text/xml", soapaction: "executeAnonymous" },
  });

  return asRecord(response);
}

function buildEnvelope(
  sessionId: string,
  apex: string,
  levels: Required<TraceConfig>,
): string {
  const categories = TRACE_CATEGORIES.map(
    (category) =>
      `<apex:categories><apex:category>${toSoapName(CATEGORY_LOG_NAMES[category])}</apex:category>` +
      `<apex:level>${toSoapName(levels[category])}</apex:level></apex:categories>`,
  ).join("");

  return (
    `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="${APEX_NAMESPACE}">` +
    `<env:Header>` +
    `<apex:SessionHeader><apex:sessionId>${escapeXml(sessionId)}</apex:sessionId></apex:SessionHeader>` +
    `<apex:DebuggingHeader>${categories}</apex:DebuggingHeader>` +
    `</env:Header>` +
    `<env:Body><executeAnonymous xmlns="${APEX_NAMESPACE}">` +
    `<apexcode>${escapeXml(apex)}</apexcode>` +
    `</executeAnonymous></env:Body></env:Envelope>`
  );
}

/** SOAP spells every category and level in title case — `DB` is `Db`. */
function toSoapName(name: string): string {
  return name.charAt(0) + name.slice(1).toLowerCase();
}

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** A nil SOAP element parses to an object, not to a string. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalText(
  key: string,
  value: unknown,
): Record<string, string> | Record<string, never> {
  const found = text(value);
  return found ? { [key]: found } : {};
}
