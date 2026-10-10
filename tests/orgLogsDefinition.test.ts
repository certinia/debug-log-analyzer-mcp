/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// No jest.mock in this file: what `tools/list` puts on the wire needs no org fakes.

import {
  deleteOrgLogsToolConfig,
  getOrgLogsToolConfig,
  listOrgLogsToolConfig,
} from "../src/tools/orgLogsDefinition";

// A hint left out reads as its default, which no token budget with headroom would notice.
describe("org log tool annotations", () => {
  it.each([
    ["list", listOrgLogsToolConfig, { readOnlyHint: true }],
    ["get", getOrgLogsToolConfig, { destructiveHint: false }],
    ["delete", deleteOrgLogsToolConfig, { destructiveHint: true }],
  ])("should annotate %s", (_name, config, annotations) => {
    expect(config.annotations).toEqual(annotations);
  });
});
