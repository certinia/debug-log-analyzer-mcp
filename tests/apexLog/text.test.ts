/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { textAt, textOf } from "../../src/apexLog";
import { logEvent, rootLog } from "../support/logEvents";

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

describe("textAt", () => {
  // The column holds the message alone, so reading it for a flow error would drop the element.
  it("reads a flow error's element, as textOf does", () => {
    const log = rootLog(0, flowError("Field is required", "Decision", "Check_Status"));

    expect(textAt(log, 1, "FLOW_ELEMENT_ERROR")).toBe("Field is required Decision Check_Status");
  });

  it("reads any other event's text from the column", () => {
    const log = rootLog(0, { type: "METHOD_ENTRY", text: "Account.save()" }, { type: "USER_DEBUG", text: null });

    expect([textAt(log, 1, "METHOD_ENTRY"), textAt(log, 2, "USER_DEBUG")]).toEqual(["Account.save()", ""]);
  });
});
