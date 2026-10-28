/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { elide, elideAround, elideEnd } from "../src/elide";

describe("elideAround", () => {
  const text = `${"a".repeat(50)}MATCH${"b".repeat(50)}`;

  it("cuts as elide does when the match is in the head elide keeps", () => {
    expect(elideAround(text, 20, 2, 5)).toBe(elide(text, 20));
  });

  it("cuts as elide does when the match is in the tail elide keeps", () => {
    expect(elideAround(text, 20, 100, 5)).toBe(elide(text, 20));
  });

  // Its start alone in the head would put the ellipsis inside it.
  it("keeps a match that straddles the head whole", () => {
    const straddling = `${"a".repeat(8)}MATCH${"b".repeat(50)}`;

    const cut = elideAround(straddling, 20, 8, 5);

    expect(cut).toHaveLength(20);
    expect(cut).toContain("MATCH");
  });

  it("keeps a match in the middle, with an ellipsis at each cut end", () => {
    const cut = elideAround(text, 20, 50, 5);

    expect(cut).toHaveLength(20);
    expect(cut).toMatch(/^…a+MATCHb+…$/);
  });

  it("keeps a match longer than the window from its start", () => {
    const long = `${"a".repeat(50)}${"M".repeat(30)}${"b".repeat(50)}`;

    expect(elideAround(long, 20, 50, 30)).toBe(`…${"M".repeat(18)}…`);
  });

  // Half a character is not valid text.
  it("steps off a surrogate pair at either cut end", () => {
    const emoji = "😀".repeat(30);
    const paired = `${emoji}MATCH${emoji}`;

    const cut = elideAround(paired, 21, 60, 5);

    expect(cut).toContain("MATCH");
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("elideEnd", () => {
  // A cut through 😀 would send a lone surrogate, which no client can render.
  it.each([
    ["keeps text that fits", "abc", 3, "abc"],
    ["cuts the end, and counts the ellipsis", "abcdef", 4, "abc…"],
    ["drops a surrogate pair the cut would split, whole", "ab😀cd", 4, "ab…"],
  ])("%s", (_name, text, maxChars, expected) => {
    expect(elideEnd(text, maxChars)).toBe(expected);
  });
});
