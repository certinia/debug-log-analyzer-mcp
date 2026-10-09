/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * Report each of `total` steps, but only to a caller that asked for progress.
 * The spec gives a token only when it wants the notifications.
 *
 * A failed notification is reported and stepped over. The work is done by the
 * last step, so a rejected notify must not throw away what it produced.
 */
export function progressReporter(
  ctx: ServerContext,
  total: number,
): (message: string) => Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message: string) => {
    if (progressToken === undefined) {
      return;
    }
    progress += 1;
    try {
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    } catch (error) {
      console.error(
        `[apex-log-mcp] Could not report progress: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
