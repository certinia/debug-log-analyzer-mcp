/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * How a failure is worded and handed back. No runtime imports, so every layer -
 * the entry point, the tools, the policy, the org code - can use it.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";

/** What a caught value says: an `Error`'s message, else the value as text, since anything can be thrown. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tool's refusal or failure: `text` as the one text block, marked as an error. */
export function toolError(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
