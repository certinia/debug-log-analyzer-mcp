# 🛠️ Developing the Apex Log MCP Server

Welcome to the development guide for the **Apex Log MCP Server**. This document will walk you through the steps required to get started with the development environment, run the server locally, and contribute to the project.

- The source code is written in [TypeScript](https://www.typescriptlang.org/).
- The tools directory contains the source code for the functionality available on the server.
- The salesforce directory contains a set of utilities for connecting to a Salesforce org.

## 📚 Table of Contents

1. [Prerequisites](#-prerequisites)
2. [Setting Up the Development Environment](#-setting-up-the-development-environment)
3. [Building](#-building)
4. [Running the Server Locally](#-running-the-server-locally)
5. [Shaping Tool Responses](#️-shaping-tool-responses)
6. [Shaping Tool Definitions](#️-shaping-tool-definitions)
7. [Testing Your Changes](#-testing-your-changes)
8. [Releasing](#-releasing)

## 🔧 Prerequisites

Before you start developing, make sure you have the following tools installed:

- **Node.js** v22 or above: [Install Node.js](https://nodejs.org/en/)
- **[pnpm](https://pnpm.io/)**: Preferred package manager
- **[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)**: This is used to connect to a Salesforce org.

Once you’ve got these ready, you’re all set to get started! 🚀

## 💻 Setting Up the Development Environment

To get started, clone this repository and install the necessary dependencies.

1. **Create a fork of the repository first**
2. **Clone the repository:**

   ```zsh
   git clone https://github.com/your-username/debug-log-analyzer-mcp.git
   cd debug-log-analyzer-mcp
   ```

3. **Install dependencies:**

   Use [pnpm](https://pnpm.io/) to install project dependencies:

   ```zsh
   pnpm i
   ```

4. **Optional: Set a default org (execute_anonymous tool only)**

   The execute anonymous Apex tool requires a default org to be set using the Salesforce CLI. To do this in a repository that has no `sfdx-project.json` like this one, set your default org globally:

   ```zsh
   sf config set target-org <username-or-alias> --global
   ```

5. **Optional: Install MCP Inspector**

   This will allow you to view a UI to easily interact with the MCP server:

   ```zsh
   npm install -g @modelcontextprotocol/inspector
   ```

## 📦 Building

You can build the server and prepare it for local development, run the watcher to re build automatically or production use. Here's how:

1. **Watch Build:**

   To build the server and then watch for file changes for a fast dev experience, use:

   ```bash
   pnpm run dev
   ```

2. **Production Build:**

   To build the server, use:

   ```bash
   pnpm run build
   ```

## 🚀 Running the Server Locally

Once you’ve built the server or run the watcher, you can run the MCP server for testing and development.

1. **Run in terminal:**

   ```zsh
   pnpm run start
   ```

2. **Run in MCP Inspector:**

   ```zsh
   mcp-inspector node dist/index.js
   ```

3. **Run against a production org:**

   All four tools are available by default. Production orgs need a per-call confirmation, or this flag:

   ```zsh
   node dist/index.js --allow-production-orgs
   ```

   To disable Apex execution altogether, use `--no-apex-execution`. See the [README](README.md#production-safety) for the full policy.

## ✂️ Shaping Tool Responses

Every token a tool returns is a token the agent cannot spend on reasoning, so responses are kept as
small as they can be — but the saving has to come from *shape*, never from dropping a fact. If a user
asks "how many DML statements did this transaction consume?", the agent has to be able to answer from
the payload alone.

### Restructure before you delete

Flattening a nested object into a TOON table is almost always a bigger win than deleting rows from
it, and it costs nothing. Measured on the 13 governor limits of a real 19 MB log:

| `governorLimits`, 13 entries | tokens | can answer "0 DML statements"? |
| --- | --- | --- |
| Nested objects, all 13 | ~151 | yes |
| Nested objects, `used > 0` only | ~42 | **no** |
| **Flat table (`{name, used, limit}`), all 13** | **~84** | yes |

The flat table is 45% cheaper than the nested form *and* complete. Deleting the zero rows buys 42
more tokens and costs the answer, so we don't. `toLimitRows` is the helper that does this.

### The conventions

The helpers in [`src/tools/responseShaping.ts`](src/tools/responseShaping.ts) exist to make these
one-liners.

- **A fixed-schema field is always reported, even at zero.** The set of governor limits, debug
  categories and method columns is fixed and known, so a zero is a fact and an absent key is an
  ambiguity — the reader cannot tell "nothing ran" from "never parsed". Report the zero.
- **Only occurrence lists are omitted when empty** — issues found, recommendations made, errors
  encountered. There, absence is unambiguous: nothing occurred. `omitEmpty` is for these and nothing
  else; never pass a fixed-schema scalar through it. (`false` is *not* empty — it is an answer.)
- **Say it once.** Never restate in prose a figure that is already in a table, and never report a
  value in two sections. Recommendations say what to *do*; the numbers stay in the data. Where prose
  carried a fact the table could not, replace it with a scalar rather than deleting it —
  `topMethodsSelfPercentage` is ~8 tokens where the paragraph it replaced was ~55.
- **Don't echo the input back.** If the caller supplied it (a file path, a flag), it does not belong
  in the response.
- **Round to the precision someone acts on.** `roundMs` for durations (3dp, keeps microsecond
  resolution) and `roundPercent` for percentages (1dp). Raw float division produces things like
  `62.569866677679975`, and every one of those digits is a token nobody reads.
- **Keep table rows identical in shape.** TOON emits one header plus one line per row only while the
  rows agree on their keys, so a column is either present on every row or on none.
- **Make conditional information conditional.** A static tip that is only relevant sometimes should
  be emitted only then.
- **Say in the tool description what is omitted and when.** Currently that is one sentence per tool,
  because there is one omission per tool.

### The gate

Output changes are checked by [`pnpm run eval`](tests/eval/README.md), which drives the built server
over stdio against committed fixtures and asserts four things per (tool, fixture): that realistic
user questions are still answerable, that no figure appears twice, that the payload is under a token
budget, and that it matches its golden file. Run it — and `pnpm run eval:update` to re-record the
goldens — for any change to a response shape; the golden diff *is* the review of the change.

Two further checks run once per run: the definition budget described in
[Shaping Tool Definitions](#️-shaping-tool-definitions), and both tables in
[Token Cost](README.md#token-cost), which are generated from the run — so a change that moves a
published figure fails until `pnpm run eval:update` regenerates the README with it.

The unit tests cannot substitute for it: jest maps `@toon-format/toon` to a JSON stand-in, so it
never sees the real encoding.

If you change a tool's output shape, update the [CHANGELOG](CHANGELOG.md) and the tool's entry in the
[README](README.md#tools-reference) — the output contract is part of the public API.

## 🏷️ Shaping Tool Definitions

A response is paid for when a tool is called. A **definition** is paid for on every request, called or
not, because the client sends all four with each one. Server `instructions` sit between them: sent once
per session. So put each fact where its audience reads it, and at the frequency it is worth. A guarantee
that holds for every tool — "a zero is a measured zero" — belongs in `instructions`, not repeated in
four descriptions. A rule that applies to one tool belongs in that tool's description.

### Budget the whole wire object

`pnpm run eval` sums `estimateTokens(JSON.stringify(tool))` for each tool in a live `tools/list`
response, so the budget covers `name`, `title`, `description`, `inputSchema`, `annotations` and
everything else the client receives. A budget over a subset of the fields guards a subset of the cost:
it would let `title` or `annotations` grow without a word of complaint.

Three assertions run against those figures:

- **Per-tool budgets** (`DEFINITION_BUDGET`), with about 5% headroom, so one careless sentence fails.
- **A total under the 1.x baseline** (`V1_DEFINITION_TOKENS`, measured at `b79328f` over this same
  stdio path). The total also catches a fifth tool, which no per-tool budget can.
- **Selection keywords** (`SELECTION_KEYWORDS`), one or two phrases per tool. A description is a
  selection prompt: clients match the words in it, so a trim that saves tokens can cost discovery.
  The keyword assertion makes that trade visible instead of silent.

The unit tests pin the parts a token budget with headroom would not notice, such as an
[annotation](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations)
hint quietly coming back.

### Only annotate what carries information

`destructiveHint` and `idempotentHint` are defined as meaningful only when `readOnlyHint` is false, so
the three read-only tools declare `readOnlyHint: true` and `openWorldHint: false` and nothing more —
both differ from the spec default, and both say something. `execute_anonymous` keeps all four hints; it
is the one tool where a client that misreads a default runs Apex against an org.

### Know the floor

Two fields per tool come from the SDK and cannot be removed through a public API: `$schema`, which
zod's `toJSONSchema` emits (~52 tokens across the four tools), and `execution`, which `McpServer` adds
(~40). About 90 tokens of the total are not ours to spend, and are not worth reaching into SDK
internals for.

## 🧪 Testing Your Changes

Make sure your changes don’t break anything. If you’re working on a feature or bug fix that requires tests, be sure to add or update the relevant tests.

Run Tests Locally:
If you have added or modified tests, you can run them with:

```zsh
pnpm test
```

or run the tests from the test explorer in VScode

If you changed anything a tool returns, also run the evaluation suite against the built server:

```zsh
pnpm run build && pnpm run eval
```

Ensure all tests pass before submitting your pull request.

## 🚢 Releasing

Publishing a release publishes to npm. `.github/workflows/publish.yml` runs on `release: published`, and `scripts/release-tag.mjs` decides which npm **dist-tag** the version goes under.

A dist-tag is a pointer to one version. `latest` is the one that matters, because `npm install @certinia/apex-log-mcp`, `@latest` and `npx` all follow it — and the VS Code extension starts this server through `npx`. A prerelease published under `latest` reaches every user on their next run, and the only way back is to publish again.

So the version chooses the channel:

| Version           | dist-tag | Installed with |
| ----------------- | -------- | -------------- |
| `2.0.0`           | `latest` | `@certinia/apex-log-mcp` |
| `2.0.0-beta.1`    | `beta`   | `@certinia/apex-log-mcp@beta` |
| `2.0.0-alpha.1`   | `alpha`  | `@certinia/apex-log-mcp@alpha` |
| `2.0.0-rc.1`      | `rc`     | `@certinia/apex-log-mcp@rc` |

`alpha`, `beta` and `rc` are the only prerelease identifiers accepted; any other fails the release rather than create a dist-tag nobody would ask for.

### Publishing a beta

Nothing changes in the release flow itself. The version string picks the channel, and the pre-release tick has to agree with it.

1. Bump the version, without a local tag — GitHub creates the tag when the release is published:

   ```zsh
   pnpm version premajor --preid beta --no-git-tag-version   # 1.0.0 -> 2.0.0-beta.0
   ```

2. Commit and push it to `main`.
3. Draft a new GitHub release, and create the tag `2.0.0-beta.0` on publish, as usual.
4. **Tick “Set as a pre-release”.** This is the only new step.
5. Publish. The workflow reads the tag, resolves `beta`, and publishes there.
6. Check the pointers: `npm dist-tag ls @certinia/apex-log-mcp`. `latest` must still be the last stable.

Later betas come from `pnpm version prerelease --no-git-tag-version`, and the stable release from `pnpm version major --no-git-tag-version`, which drops the identifier — and then the tick comes off.

To see the dist-tag before you tag anything:

```zsh
RELEASE_TAG=2.0.0-beta.0 PRERELEASE=true node scripts/release-tag.mjs
```

### When the release is refused

The check runs before the install, and long before the publish, so a refused release leaves npm untouched. Correct the version or the tick and release again.

Re-running the failed job does not help: a re-run replays the original event, so it carries the same pre-release flag that failed. Delete the release and create it again — the git tag can stay, and the new release selects it instead of creating it.

### The changelog

`## [Unreleased]` stays as it is through the betas. A beta is a preview of the same unreleased content, not its own set of changes; the heading becomes `## [2.0.0] - <date>` when the stable release is tagged.
