/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// No import of `@salesforce/core`: server.ts wraps every org handler with this at startup.

/** The step for an org whose saved login no longer works: the user's, since it opens a browser. */
export const RELOGIN_HINT =
  "Ask the user to log in to the org again: sf org login web --alias <alias>.";

// What the API sends for a dead session.
const AUTH_FAILURE_CODES: ReadonlySet<unknown> = new Set(["INVALID_SESSION_ID", "INVALID_AUTH_HEADER"]);

// @salesforce/core wraps every failed refresh, a network fault too; `invalid_grant` is the org refusing the stored login.
function isRefusedRefresh(error: Error): boolean {
  return error.name === "RefreshTokenAuthError" && (error.cause as Error | undefined)?.name === "invalid_grant";
}

/** `error` with `RELOGIN_HINT` added when it says the org's login no longer works, else `error` itself. */
export function withReloginHint(error: unknown): unknown {
  if (!(error instanceof Error) || error.message.includes(RELOGIN_HINT)) {
    return error;
  }
  const { errorCode } = error as { errorCode?: unknown };
  if (!isRefusedRefresh(error) && !AUTH_FAILURE_CODES.has(errorCode)) {
    return error;
  }
  return new Error(`${error.message} ${RELOGIN_HINT}`, { cause: error });
}
