/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Parse and analysis speed and memory, over a directory of real logs.
 *
 * Run before and after a parser change, on the same directory, and put both
 * tables in the PR. It reads the *built* server, so build first.
 *
 * Each log runs in its own `node --expose-gc` process, so one log's heap does
 * not change the next one's figures. Per log it takes the median of five runs
 * of: a cold `loadApexLog`; each analysis tool's `run` on that log, warm; the
 * heap the parse holds after a GC (`heapUsed + arrayBuffers`). Peak RSS is the
 * process's, after all five. The table states medians per size bucket, and
 * names no log: the logs may be a customer's.
 *
 * Usage:
 *   pnpm run bench <dir>                 # the build in ./dist
 *   pnpm run bench <dir> --dist <path>   # another build, as one of main
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNS = 5;
const MB = 1024 * 1024;

const BUCKETS = [
  { name: "< 1 MB", below: 1 * MB },
  { name: "1-10 MB", below: 10 * MB },
  { name: "10-50 MB", below: 50 * MB },
  { name: ">= 50 MB", below: Infinity },
];

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const heldBytes = () => {
  globalThis.gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};

// A build from before `src/apexLog/` kept the loader in `tools/apexLogSource.js`.
const loaderIn = (dist) =>
  ["apexLog/index.js", "tools/apexLogSource.js"]
    .map((module) => path.join(dist, module))
    .find((file) => existsSync(file));

/** One log, in this process: prints one JSON line of its medians. */
async function measureOne(file, dist) {
  const { clearApexLogCache, loadApexLog } = await import(pathToFileURL(loaderIn(dist)).href);
  const { analysisTools } = await import(
    pathToFileURL(path.join(dist, "tools", "analysisTools.js")).href
  );

  // A function per run, returning numbers alone, so no log outlives its run
  // and the next run's baseline holds none of it.
  const measureRun = async () => {
    clearApexLogCache();
    const before = heldBytes();
    const start = performance.now();
    const log = await loadApexLog(file);
    const loadMs = performance.now() - start;
    const held = heldBytes() - before;

    const toolMs = Object.fromEntries(
      analysisTools.map((tool) => {
        const toolStart = performance.now();
        tool.run(log, {});
        return [tool.name, performance.now() - toolStart];
      }),
    );
    clearApexLogCache();
    return { loadMs, held, toolMs };
  };

  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    runs.push(await measureRun());
  }

  const result = {
    sizeBytes: statSync(file).size,
    loadMs: median(runs.map((run) => run.loadMs)),
    heldBytes: median(runs.map((run) => run.held)),
    toolMs: Object.fromEntries(
      Object.keys(runs[0].toolMs).map((name) => [name, median(runs.map((run) => run.toolMs[name]))]),
    ),
    // Kilobytes, as `getrusage` states it.
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  process.stdout.write(JSON.stringify(result));
}

/** Every log in `dir`, each in a child process, as one table. */
function measureAll(dir, dist) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => path.join(dir, name));
  const script = fileURLToPath(import.meta.url);

  let failed = 0;
  const results = files.flatMap((file, index) => {
    process.stderr.write(`\r${index + 1}/${files.length}`);
    try {
      const out = execFileSync(
        process.execPath,
        ["--expose-gc", "--max-old-space-size=8192", script, "--one", file, "--dist", dist],
        { encoding: "utf-8", maxBuffer: 1 * MB, stdio: ["ignore", "pipe", "pipe"] },
      );
      return [JSON.parse(out)];
    } catch (error) {
      failed++;
      // Piped, not inherited, so the log's path is cut from the reason: the logs may be a customer's.
      const reason = (error.stderr?.trim() || error.message).replaceAll(file, "<log>");
      process.stderr.write(`\nlog ${index + 1} failed: ${reason}\n`);
      return [];
    }
  });
  process.stderr.write("\n");

  const tools = Object.keys(results[0]?.toolMs ?? {});
  const ms = (value) => value.toFixed(1);
  const mb = (value) => (value / MB).toFixed(1);
  const header = ["size", "logs", "load ms", ...tools.map((name) => `${name.replace("apexlog_", "")} ms`), "held MB", "held / file", "peak RSS MB"];
  const rows = BUCKETS.map((bucket, index) => {
    const floor = BUCKETS[index - 1]?.below ?? 0;
    const inBucket = results.filter(({ sizeBytes }) => sizeBytes >= floor && sizeBytes < bucket.below);
    if (inBucket.length === 0) {
      return null;
    }
    const of = (pick) => median(inBucket.map(pick));
    return [
      bucket.name,
      inBucket.length,
      ms(of((r) => r.loadMs)),
      ...tools.map((name) => ms(of((r) => r.toolMs[name]))),
      mb(of((r) => r.heldBytes)),
      of((r) => r.heldBytes / r.sizeBytes).toFixed(2),
      mb(of((r) => r.peakRssBytes)),
    ];
  }).filter((row) => row !== null);

  const line = (cells) => `| ${cells.join(" | ")} |`;
  console.log([line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n"));
  console.log(`\nMedians of each log's median of ${RUNS} runs. ${failed} log(s) failed to load and are left out.`);
  if (results.length === 0) {
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const dist = path.resolve(flag("--dist") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist"));

if (!loaderIn(dist)) {
  console.error(`No log loader in ${dist}: build first`);
  process.exit(1);
}

if (flag("--one")) {
  await measureOne(flag("--one"), dist);
} else if (args[0] && !args[0].startsWith("--")) {
  measureAll(path.resolve(args[0]), dist);
} else {
  console.error("Usage: pnpm run bench <dir> [--dist <path>]");
  process.exit(1);
}
