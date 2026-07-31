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
6. [Testing Your Changes](#-testing-your-changes)

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

The unit tests cannot substitute for it: jest maps `@toon-format/toon` to a JSON stand-in, so it
never sees the real encoding.

If you change a tool's output shape, update the [CHANGELOG](CHANGELOG.md) and the tool's entry in the
[README](README.md#tools-reference) — the output contract is part of the public API.

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
