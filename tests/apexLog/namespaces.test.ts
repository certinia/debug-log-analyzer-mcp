/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { namespacesOf, type ApexLog } from "../../src/apexLog";
import { rootLog, type NodeSpec } from "../support/logEvents";

// The parser names `pse` and `appirio_core`; an event in none is `default`.
const logWith = (namespaces: string[], ...children: NodeSpec[]): ApexLog =>
  ({ ...rootLog(0, ...children), namespaces }) as ApexLog;

describe("namespacesOf", () => {
  it("lists no default when every event is in a namespace", () => {
    expect(namespacesOf(logWith(["pse"], { namespace: "pse" }))).toEqual(["pse"]);
  });

  // A namespace only a limit block names is still one the log states.
  it("keeps a namespace no event is in, in the parser's order", () => {
    const log = logWith(["pse", "fferpcore"], { namespace: "pse" }, { namespace: null });

    expect(namespacesOf(log)).toEqual(["pse", "default", "fferpcore"]);
  });
});
