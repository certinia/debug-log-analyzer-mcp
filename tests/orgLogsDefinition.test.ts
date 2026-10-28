/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// No jest.mock in this file: what `tools/list` puts on the wire needs no org fakes.

import { getOrgLogsTool, listOrgLogsTool } from "../src/tools/orgLogsDefinition";
import { createTraceFlagTool } from "../src/tools/traceFlagsDefinition";

// A hint left out reads as its default, which no token budget with headroom would notice.
describe("org tool annotations", () => {
  it.each([
    ["list", listOrgLogsTool.config, { readOnlyHint: true }],
    ["get", getOrgLogsTool.config, { destructiveHint: false }],
    ["create trace flag", createTraceFlagTool().config, { destructiveHint: false }],
  ])("should annotate %s", (_name, config, annotations) => {
    expect(config.annotations).toEqual(annotations);
  });
});
