/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/** What a caught value says: an `Error`'s message, else the value as text, since anything can be thrown. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
