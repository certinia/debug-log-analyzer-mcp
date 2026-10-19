/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { RELOGIN_HINT, withReloginHint } from "../../src/salesforce/authFailure";

// As @salesforce/core wraps a failed token refresh: the cause is what the refresh threw.
const refreshFailure = (causeName: string): Error =>
  Object.assign(new Error("expired"), {
    name: "RefreshTokenAuthError",
    cause: Object.assign(new Error("expired access/refresh token"), { name: causeName }),
  });

const coded = (errorCode: string): Error =>
  Object.assign(new Error("expired"), { errorCode });

describe("withReloginHint", () => {
  it.each([
    ["the org refuses the stored login", refreshFailure("invalid_grant")],
    ["the session is dead", coded("INVALID_SESSION_ID")],
    ["the auth header is refused", coded("INVALID_AUTH_HEADER")],
  ])("should tell the agent to ask for a new login when %s", (_name, error) => {
    const hinted = withReloginHint(error) as Error;

    expect(hinted.message).toBe(`expired ${RELOGIN_HINT}`);
    expect(hinted.cause).toBe(error);
  });

  it("should add the hint once", () => {
    const once = withReloginHint(coded("INVALID_SESSION_ID"));

    expect(withReloginHint(once)).toBe(once);
  });

  it.each([
    ["a refresh that failed on the network", refreshFailure("TypeError")],
    ["an org that no longer exists", Object.assign(new Error("gone"), { name: "OrgDataNotAvailableError" })],
    ["another error", new Error("Locked")],
    ["a value that is not an error", "expired"],
  ])("should leave %s as it is", (_name, error) => {
    expect(withReloginHint(error)).toBe(error);
  });
});
