#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { ApexLogServer } from "./server.js";

const server = new ApexLogServer();
server.run().catch(console.error);
