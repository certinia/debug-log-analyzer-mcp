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
  errors: { message: string }[];
}): Omit<DeleteResult, "id"> {
  if (result.success) {
    return {};
  }
  if (isAlreadyGone(result.errors)) {
    return { alreadyGone: true };
  }
  return {
    error:
      result.errors.map((error) => error.message).join("; ") ||
      "the org gave no reason",
  };
}

/** One record's outcome, from what a delete of one threw. */
export function thrownOutcome(error: unknown): Omit<DeleteResult, "id"> {
  if (typeof error === "object" && error !== null && isAlreadyGone([error])) {
    return { alreadyGone: true };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
