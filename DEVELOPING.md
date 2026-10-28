# 🛠️ Developing the Apex Log MCP Server

**What this file is for:** how to set up, build, run, test and release the server, and the rules every
change follows. It is for developers and coding agents.

**What it is not for:** recording decisions. Write a rule here as what to do, and only if it applies
across tools. The [`repo-docs`](.claude/skills/repo-docs/SKILL.md) skill says where the evidence for
a rule goes.

- The source code is [TypeScript](https://www.typescriptlang.org/).
- `src/tools/` holds the MCP tools and the helpers they share. An analysis tool is one module, listed in `analysisTools.ts`. An org tool's handler is one module, and what `tools/list` sends for it is in a `*Definition.ts`.
- `src/salesforce/` connects to a Salesforce org.
- The modules at the top of `src/`, apart from `index.ts` and `server.ts`, are helpers every folder may import. They import from no folder.

## 📚 Table of Contents

1. [Prerequisites](#-prerequisites)
2. [Setting Up the Development Environment](#-setting-up-the-development-environment)
3. [Building](#-building)
4. [Running the Server Locally](#-running-the-server-locally)
5. [Naming Tools and Fields](#-naming-tools-and-fields)
6. [Shaping Tool Responses](#️-shaping-tool-responses)
7. [Shaping Tool Definitions](#️-shaping-tool-definitions)
8. [Testing Your Changes](#-testing-your-changes)
9. [Releasing](#-releasing)

## 🔧 Prerequisites

- **Node.js** v22 or above: [Install Node.js](https://nodejs.org/en/)
- **[pnpm](https://pnpm.io/)**: the package manager
- **[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)**: connects to a Salesforce org

## 💻 Setting Up the Development Environment

1. **Create a fork of the repository first**
2. **Clone the repository:**

   ```zsh
   git clone https://github.com/your-username/debug-log-analyzer-mcp.git
   cd debug-log-analyzer-mcp
   ```

3. **Install dependencies:**

   ```zsh
   pnpm i
   ```

4. **Optional: Set a default org (org tools only)**

   The org tools use the Salesforce CLI's default org when `targetOrg` is left out. To set one in a repository that has no `sfdx-project.json` like this one, set your default org globally:

   ```zsh
   sf config set target-org <username-or-alias> --global
   ```

5. **Optional: Install MCP Inspector**, a UI to call the server's tools:

   ```zsh
   npm install -g @modelcontextprotocol/inspector
   ```

## 📦 Building

1. **Watch build**, which rebuilds on each file change:

   ```bash
   pnpm run dev
   ```

2. **Production build:**

   ```bash
   pnpm run build
   ```

## 🚀 Running the Server Locally

Build the server, or run the watcher, first.

1. **Run in terminal:**

   ```zsh
   pnpm run start
   ```

2. **Run in MCP Inspector:**

   ```zsh
   mcp-inspector node dist/index.js
   ```

3. **Run against a production org:**

   All eight tools are available by default. A write against a production org - running Apex or creating a trace flag - needs a per-call confirmation, or this flag; a read does not:

   ```zsh
   node dist/index.js --allow-production-orgs
   ```

   To disable Apex execution altogether, use `--no-apex-execution`. To refuse every tool that changes an org, use `--read-only`. To refuse named orgs or whole org types, whatever `--allow-production-orgs` says, use `--deny-orgs`. See the [README](README.md#production-safety) for the full policy.

## 🔤 Naming Tools and Fields

A name has to be decidable: for any new tool or field, exactly one name follows from these rules. The
reader is an agent that cannot ask what a name means.

### Prefix every tool with `apexlog_`

Unprefixed names collide across servers: `get_issue` ships in both the GitHub and the Sentry server.
Write it as one unit - `apexlog_`, not `apex_log_` - so the boundary between the prefix and the verb
is visible.

### The verb states the shape of the result

| Verb | The caller gets back |
| --- | --- |
| `get_` | one or more things, each named by the input: by id, or as a count of the latest |
| `list_` | a collection; filters, thresholds and ranking are allowed |
| `search_` | a collection matched to a query the caller supplies |
| `create_` / `update_` / `delete_` / `write_` | one resource, written; a `delete_` may name several, by id or by the filters of its `list_` |
| `execute_` / `run_` | an effect outside this server |

- A filter does not make it a `search_`: Sentry's `list_issues` and GitHub's `list_pull_requests` both
  take filters. `search_` is for a caller's query string.
- Do not use `analyze`, `process`, `handle` or `manage`: they name work, so two tools can both claim
  them. Do not use `find`, `detect`, `check` or `fetch`: they are synonyms of the verbs above.
- The noun states what the result is, in the caller's words: `slow_operations`, not `timed_nodes`.
- Always use a verb. A bare noun (`apexlog_summary`) cannot say whether one thing or many come back.
  `git_status` works only because git's subcommands are its vocabulary; ours are not.

### Fields

1. **Name the fact, not the calculation**: `returnedSelfPercentage`, not `coveredSelfPercentage`.
2. **Carry the unit** when the type cannot: `durationSelfMs`, `fileSizeBytes`.
3. **`total` always means "including children", `self` always means "excluding them".** Never "summed
   across rows". A log's duration is its root frame's, so `durationTotalMs` names it at every scope.
4. **One name per fact, in every tool.** A word may serve two unrelated facts where position prevents
   confusion: `limit` is both the input row count and the column naming a governor limit.
5. **Counts are `<singularNoun>Count`**: `soqlCount`, `dmlRowCount`. Not `totalX`, not a plural alone.
6. **lowerCamel, acronyms folded**: `soqlCount`.
7. **Booleans are bare adjectives that read true**: `truncated`, `succeeded`. No `isX`, no `hasX`.
8. **An input names what it limits, on the axis it acts on**: `limit`, `minSelfMs`.

## ✂️ Shaping Tool Responses

Every token a tool returns is a token the agent cannot spend on reasoning, so keep responses small.
Get the saving from the *shape*, never from dropping a fact: the agent must be able to answer from the
payload alone. The helpers in [`src/tools/responseShaping.ts`](src/tools/responseShaping.ts) make
most of these rules one-liners.

### What to report

- **Restructure before you delete.** Flatten nested objects into a table first (`toLimitRows`): it is
  cheaper and keeps every fact.
- **Report a fixed-schema field even at zero.** The set of governor limits, debug categories and
  columns is fixed, so a zero is a fact and an absent key reads as "never parsed".
- **Omit only an empty occurrence list** - issues found, errors met - with `omitEmpty`. Never pass a
  fixed-schema field through it. `false` is not empty: it is an answer.
- **Say it once.** Never restate a table's figure in prose, and never report a value in two sections.
  Where prose carried a fact no table holds, replace it with a scalar rather than delete it.
- **Do not state what the caller can derive.** Report the fact, not the advice built on it: the agent
  reads every column and applies its own rule.
- **Do not echo the input back.** A file path or flag the caller supplied does not belong in the
  response.
- **Round to the precision someone acts on**: `roundMs` (3dp) for durations, `roundPercent` (1dp) for
  percentages.

### Bounding a response

- **Read the bounded view, and cap what is still unbounded in it.** Prefer a deduped source to one that
  lists every occurrence. Cap free text the log controls - a message, a stack - since its size is the
  log's to choose.
- **Cap the payload, not the row count.** A page stops at `PAGE_CHAR_BUDGET` (`fitPage`), and a long
  name is elided at `NAME_LIMIT`. Return fewer rows than asked rather than overflow; `matchedCount`
  says the page was cut.
- **Say in the tool description what is omitted, and when.**

### The shape

- **A fact that qualifies the whole response is a scalar, stated once; a fact that varies per row is a
  column.**
- **Keep table rows identical in shape.** TOON writes one header per table only while every row has the
  same keys, so a column is on every row or on none.
- **Report the capture level beside the figures it qualifies** (`capturedAt`, or a `level` column). A
  level silently changes what each figure means. Name the categories the figures came from; where the
  query does not fix them, name every declared level.
- **Never default a level the header did not declare.** A level has no zero: leave the category out, or
  state it empty.
- **No caveat prose, and no magnitude.** Report the level and stop: a figure measured once, against
  one org, cannot be re-derived by CI and goes stale.
- **A fact worth an answer but not worth a column is a parameter that reshapes the rows** - a `groupBy`
  or a `sortBy`. A column only that parameter fills appears under it alone; that is not an omission,
  because the parameter says which it is.
- **Report a table even when empty, beside the parameter that selected it**, since a cutoff left
  unstated cannot be read.
- **Encode with the TOON defaults** (`toonResult`).

If you change what a tool returns, update the [CHANGELOG](CHANGELOG.md) and the tool's entry in the
[README](README.md#tools-reference): the output contract is part of the public API.

## 🏷️ Shaping Tool Definitions

A definition is charged on every request, called or not. Server `instructions` are charged once per
session, and a response only when the tool is called.

- Put a fact true of every tool in `instructions`, and a fact true of one in that tool's description.
- Put a parameter's range in its schema constraints, and its format and default in its `.describe()`.
  The description repeats none of them, because the client receives the schema beside it - even where
  a directory that scores descriptions on their own marks this down.
- Do not describe a failure several tools share, such as a bad path or a denied org, in each tool. The
  error text says it when it happens.
- A description is a selection prompt, so a trim can cost discovery. `SELECTION_KEYWORDS` in
  [`scripts/eval.mjs`](scripts/eval.mjs) fails a trim that drops a word clients search on.

The [MCP spec](https://modelcontextprotocol.io/specification/latest/server/tools) says what `title`,
`description` and each annotation are for. Where it is silent, `pnpm run eval` is the rule. Pin each
annotation in the tool's definition test - for the analysis tools, `tests/analysisTool.test.ts` -
because a budget with headroom does not notice one coming back.

## 🧪 Testing Your Changes

Add or update tests for the behaviour you change. Run them, or run them from the VS Code test
explorer:

```zsh
pnpm test
```

If you changed what a tool returns or how it is defined, also run the evaluation suite against the
built server:

```zsh
pnpm run build && pnpm run eval
```

`pnpm run eval` drives the built server over stdio against committed fixtures.
[`tests/eval/README.md`](tests/eval/README.md) lists what it checks.

Re-record the goldens and the README blocks with `pnpm run build && pnpm run eval:update`, then read
the diff: the
golden diff *is* the review of a shape change. Edit only the prose around the generated blocks by
hand.

The unit tests cannot replace the eval: jest maps `@toon-format/toon` to a JSON stand-in, so it never
sees the real encoding.

Make sure all tests pass before you open a pull request.

## 🚢 Releasing

Publishing a release publishes to npm. `.github/workflows/publish.yml` runs on `release: published`, and `scripts/release-tag.mjs` decides which npm **dist-tag** the version goes under.

A dist-tag is a pointer to one version. `latest` is the one that matters, because `npm install @certinia/apex-log-mcp`, `@latest` and `npx` all follow it - and every documented client setup starts this server through `npx`. A prerelease published under `latest` reaches every user on their next run, and the only way back is to publish again.

So the version chooses the channel:

| Version           | dist-tag | Installed with |
| ----------------- | -------- | -------------- |
| `2.0.0`           | `latest` | `@certinia/apex-log-mcp` |
| `2.0.0-beta.1`    | `beta`   | `@certinia/apex-log-mcp@beta` |
| `2.0.0-alpha.1`   | `alpha`  | `@certinia/apex-log-mcp@alpha` |
| `2.0.0-rc.1`      | `rc`     | `@certinia/apex-log-mcp@rc` |

`alpha`, `beta` and `rc` are the only prerelease identifiers accepted; any other fails the release rather than create a dist-tag nobody would ask for.

### Publishing a beta

The version string picks the channel, and the pre-release tick has to agree with it.

1. Bump the version, without a local tag - GitHub creates the tag when the release is published:

   ```zsh
   pnpm version premajor --preid beta --no-git-tag-version   # 2.x.y -> 3.0.0-beta.0
   ```

2. Commit and push it to `main`.
3. Draft a new GitHub release, and create the tag `3.0.0-beta.0` on publish.
4. **Tick “Set as a pre-release”.**
5. Publish. The workflow reads the tag, resolves `beta`, and publishes there.
6. Check the pointers: `npm dist-tag ls @certinia/apex-log-mcp`. `latest` must still be the last stable.

Later betas come from `pnpm version prerelease --no-git-tag-version`, and the stable release from `pnpm version major --no-git-tag-version`, which drops the identifier - and then the tick comes off.

To see the dist-tag before you tag anything:

```zsh
RELEASE_TAG=3.0.0-beta.0 PRERELEASE=true node scripts/release-tag.mjs
```

### When the release is refused

The check runs before the install, and long before the publish, so a refused release leaves npm untouched. Correct the version or the tick and release again.

Re-running the failed job does not help: a re-run replays the original event, so it carries the same pre-release flag that failed. Delete the release and create it again - the git tag can stay, and the new release selects it instead of creating it.

### The changelog

`## [Unreleased]` stays as it is through the betas. A beta is a preview of the same unreleased content, not its own set of changes; the heading becomes `## [3.0.0] - <date>` when the stable release is tagged.
