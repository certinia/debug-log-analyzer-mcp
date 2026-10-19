/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// Few enough that a large job does not trip the org's concurrent request limit.
const PARALLEL_REQUESTS = 4;

/**
 * `fn` over `items`, at most four at a time, results in input order. A pool,
 * not batches, so one slow request holds up one slot, not a batch. Once `fn`
 * throws, no further item starts and the call rejects.
 */
export async function mapRequests<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        // In range: the loop checked `next` before taking it.
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_REQUESTS, items.length) }, worker),
  );
  return results;
}
