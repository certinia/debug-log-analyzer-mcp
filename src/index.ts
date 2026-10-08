#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import "./salesforce/logging.js";
import {
  parseServerConfig,
  runStdioServer,
  type ServerConfig,
} from "./server.js";

let config: ServerConfig;
try {
  config = parseServerConfig(process.argv.slice(2));
} catch (error) {
  // The client shows stderr as is, so a bad flag gets one line, not a stack.
  console.error(
    `[apex-log-mcp] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

runStdioServer(config);
