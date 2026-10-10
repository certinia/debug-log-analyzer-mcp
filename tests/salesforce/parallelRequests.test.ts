/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { mapRequests } from "../../src/salesforce/parallelRequests";

describe("mapRequests", () => {
  // More at once trips the org's concurrent request limit; fewer wastes a slot.
  it("should run four at a time, and keep the input order", async () => {
    let running = 0;
    let most = 0;
    const items = Array.from({ length: 10 }, (_, index) => index);

    const results = await mapRequests(items, async (item) => {
      running += 1;
      most = Math.max(most, running);
      // Later items finish first, so order comes from the index, not from completion.
      await new Promise((resolve) => setTimeout(resolve, 10 - item));
      running -= 1;
      return item * 2;
    });

    expect(most).toBe(4);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  // A batch would wait for its slowest member before the next four start.
  it("should start the next item in a free slot while a slow one still runs", async () => {
    let slowDone = false;
    let startedBeforeSlowDone = false;

    await mapRequests([0, 1, 2, 3, 4], async (item) => {
      if (item === 4) {
        startedBeforeSlowDone = !slowDone;
      }
      if (item === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        slowDone = true;
      }
      return item;
    });

    expect(startedBeforeSlowDone).toBe(true);
  });

  it("should start no further item once one fails", async () => {
    const fn = jest.fn(async (item: number) => {
      if (item === 0) {
        throw new Error("REQUEST_LIMIT_EXCEEDED");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item;
    });

    await expect(mapRequests([0, 1, 2, 3, 4, 5, 6, 7], fn)).rejects.toThrow(
      "REQUEST_LIMIT_EXCEEDED",
    );
    // Long enough for the three still running to finish and look for more.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
