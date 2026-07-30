#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { ApexLogServer, parseServerConfig } from "./server.js";

const server = new ApexLogServer(parseServerConfig(process.argv.slice(2)));
server.run().catch(console.error);
