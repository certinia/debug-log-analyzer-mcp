#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import "./salesforce/logging.js";
import { parseServerConfig, runStdioServer } from "./server.js";

runStdioServer(parseServerConfig(process.argv.slice(2)));
