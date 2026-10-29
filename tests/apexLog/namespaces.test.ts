/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { namespacesOf, type ApexLog } from "../../src/apexLog";
import { rootLog, type NodeSpec } from "../support/logEvents";

// The parser names `pse` and `appirio_core`; an event in none is `default`.
const logWith = (namespaces: string[], ...children: NodeSpec[]): ApexLog =>
  ({ ...rootLog(0, ...children), namespaces }) as ApexLog;

describe("namespacesOf", () => {
  // `apexlog_get_summary.namespaces` has always listed `default` where it first ran, not first.
  it("places default where the first event in no namespace appears", () => {
    const log = logWith(
      ["pse", "appirio_core"],
      { namespace: "pse" },
      { namespace: null },
      { namespace: "appirio_core" },
    );

    expect(namespacesOf(log)).toEqual(["pse", "default", "appirio_core"]);
  });

  it("lists no default when every event is in a namespace", () => {
    expect(namespacesOf(logWith(["pse"], { namespace: "pse" }))).toEqual(["pse"]);
  });

  // A namespace only a limit block names is still one the log states.
  it("keeps a namespace no event is in, after the ones events are in", () => {
    const log = logWith(["fferpcore", "pse"], { namespace: null }, { namespace: "pse" });

    expect(namespacesOf(log)).toEqual(["default", "pse", "fferpcore"]);
  });
});
