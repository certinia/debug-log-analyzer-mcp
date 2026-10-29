/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { textOf } from "../../src/apexLog";
import { logEvent } from "../support/logEvents";

const flowError = (
  text: string | null,
  elementType: string | null,
  elementName: string | null,
) => ({ type: "FLOW_ELEMENT_ERROR", text, details: { elementType, elementName } });

describe("textOf", () => {
  // 0.4 moved the failed element out of the text; the log line states it after the message.
  it.each([
    ["Field is required", "Decision", "Check_Status", "Field is required Decision Check_Status"],
    ["Field is required", "Decision", null, "Field is required Decision"],
    ["Field is required", null, "Check_Status", "Field is required Check_Status"],
    [null, "Decision", "Check_Status", "Decision Check_Status"],
    [null, null, null, ""],
  ])("puts a flow error's element after its message (%s, %s, %s)", (text, elementType, elementName, expected) => {
    expect(textOf(logEvent(flowError(text, elementType, elementName)))).toBe(expected);
  });

  it("gives an empty string for an event that says nothing", () => {
    expect(textOf(logEvent({ type: "METHOD_ENTRY", text: null }))).toBe("");
  });
});
