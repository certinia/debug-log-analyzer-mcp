/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { walkLog, type ApexEvent } from "../../src/apexLog";

describe("walkLog", () => {
  it("visits the node and every node below it, parents first", () => {
    const tree = {
      type: "root",
      children: [
        { type: "a", children: [{ type: "a1", children: [] }] },
        { type: "b", children: [] },
      ],
    } as unknown as ApexEvent;

    const seen: string[] = [];
    walkLog(tree, (node) => seen.push(node.type as string));

    expect(seen).toEqual(["root", "a", "a1", "b"]);
  });
});
