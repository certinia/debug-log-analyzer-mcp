/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// No jest.mock in this file: what `tools/list` puts on the wire needs no org fakes.

import {
  getOrgLogsToolConfig,
  listOrgLogsToolConfig,
} from "../src/tools/orgLogsDefinition";
import { createTraceFlagToolConfig } from "../src/tools/traceFlagsDefinition";

// A hint left out reads as its default, which no token budget with headroom would notice.
describe("org tool annotations", () => {
  it.each([
    ["list", listOrgLogsToolConfig, { readOnlyHint: true }],
    ["get", getOrgLogsToolConfig, { destructiveHint: false }],
    ["create trace flag", createTraceFlagToolConfig(), { destructiveHint: false }],
  ])("should annotate %s", (_name, config, annotations) => {
    expect(config.annotations).toEqual(annotations);
  });
});
