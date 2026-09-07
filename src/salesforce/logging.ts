/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Turn the Salesforce CLI log off, before anything reaches `@salesforce/core`.
 *
 * Core logs through a pino worker thread nothing listens to, so a failed write
 * to `~/.sf` ends the process, and under `DEBUG` it writes to stdout, which is
 * the MCP transport. Nothing here reads that log. Set `SF_DISABLE_LOG_FILE` to
 * anything but `true` to keep it, and it goes to stderr.
 *
 * A module of its own, because a module body runs after every import it sits
 * beside: only the import graph can put this ahead of core's first `Logger`.
 * So every module that value-imports the SDK imports this first, and so does
 * `src/index.ts` for the `bin`.
 */
process.env.SF_DISABLE_LOG_FILE ||= "true";
process.env.SF_LOG_STDERR ||= "true";
