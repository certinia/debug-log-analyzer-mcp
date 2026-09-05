/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Fail the process if it resolves the Salesforce SDK.
 *
 * Loaded with `--import` ahead of `dist/index.js`, so `scripts/eval.mjs` can
 * assert that starting the server and listing its tools never reaches the SDK.
 * The ESLint rule and `tests/salesforceCoreIsLazy.test.ts` read `src/`; this
 * reads the artifact that ships, which is what the published startup figure is
 * measured against.
 *
 * Matched on the package, not on one specifier: `jsforce` is most of what the
 * SDK costs to load, so reaching it by another route is the same regression.
 */

import { registerHooks } from "node:module";

const BANNED = /^(@salesforce\/|jsforce($|\/))/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (BANNED.test(specifier)) {
      throw new Error(
        `${specifier} was loaded before any tool ran. It belongs behind the await import() in src/server.ts.`,
      );
    }
    return nextResolve(specifier, context);
  },
});
