# Contributing to Apex Log MCP Server

Thank you for contributing. Read the [code of conduct](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CODE_OF_CONDUCT.md) first.

## Before you start

1. Search the [open issues](https://github.com/certinia/debug-log-analyzer-mcp/issues) for your idea or bug.
2. If nothing matches, open an issue before you start, so we can agree the approach and avoid duplicate work.

To set up your environment, see the [Development Guide](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md).

## Steps

1. Fork the repo, and clone your fork.
2. Create a feature branch, for example `feat-some-description` or `bug-some-description`.
3. Make your changes, push them, and open a PR.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), with the subject in the imperative: "fix: date parsing in log parser", not "fixed date parsing in log parser".

- `feat: add namespace filtering to performance analysis`
- `fix: handle empty debug logs gracefully`
- `docs: add Claude Desktop configuration example`
- `refactor: simplify trace flag validation`
- `test: add coverage for bottleneck detection`

## Before you open a PR

- [ ] All tests pass (`pnpm test`)
- [ ] TypeScript compiles without errors (`pnpm run build`)
- [ ] Linting passes (`pnpm run lint`)
- [ ] New features include tests where appropriate

## Help

If you get stuck, open an issue or ask in the [discussions](https://github.com/certinia/debug-log-analyzer-mcp/discussions).
