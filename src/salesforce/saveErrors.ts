/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

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

/** A result's `errors` as a list: jsforce types it as an array, but a single error, or none, has been seen in its place. */
export function errorList(errors: unknown): unknown[] {
  if (errors === undefined || errors === null) {
    return [];
  }
  return Array.isArray(errors) ? errors : [errors];
}
