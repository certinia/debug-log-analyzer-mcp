/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/** One record's outcome: deleted, gone before the delete reached it, or failed with the cause. */
export type DeleteResult = { id: string; alreadyGone?: true; error?: string };

// What the org answers for a record deleted since it was found; a log or a trace flag has no recycle bin.
const GONE_CODES: ReadonlySet<unknown> = new Set(["INVALID_CROSS_REFERENCE_KEY", "ENTITY_IS_DELETED"]);

// jsforce types `errorCode`, but the collection API sends `statusCode`.
function isAlreadyGone(errors: object[]): boolean {
  return (
    errors.length > 0 &&
    errors.every((error) => {
      const { statusCode, errorCode } = error as { statusCode?: unknown; errorCode?: unknown };
      // Both, since a thrown HTTP error can carry a numeric statusCode beside the errorCode.
      return GONE_CODES.has(statusCode) || GONE_CODES.has(errorCode);
    })
  );
}

/** One record's outcome, from the result a delete of many returns for it. */
export function savedOutcome(result: {
  success: boolean;
  errors?: unknown;
}): Omit<DeleteResult, "id"> {
  if (result.success) {
    return {};
  }
  const errors = errorList(result.errors);
  if (isAlreadyGone(errors.filter((error): error is object => typeof error === "object" && error !== null))) {
    return { alreadyGone: true };
  }
  return { error: saveErrorText(errors) };
}

/** The org's reasons for refusing a save or delete, as one line, with the fields each names. */
export function saveErrorText(errors: unknown): string {
  return (
    errorList(errors)
      .map((error) => {
        if (typeof error === "string") {
          return error;
        }
        const { message, fields } = (error ?? {}) as { message?: unknown; fields?: unknown };
        if (typeof message !== "string") {
          return JSON.stringify(error);
        }
        return Array.isArray(fields) && fields.length ? `${message} (${fields.join(", ")})` : message;
      })
      .join("; ") || "the org gave no reason"
  );
}

// jsforce types `errors` as an array, but a single error, or none, has been seen in its place.
function errorList(errors: unknown): unknown[] {
  if (errors === undefined || errors === null) {
    return [];
  }
  return Array.isArray(errors) ? errors : [errors];
}

/** One record's outcome, from what a delete of one threw. */
export function thrownOutcome(error: unknown): Omit<DeleteResult, "id"> {
  if (typeof error === "object" && error !== null && isAlreadyGone([error])) {
    return { alreadyGone: true };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
