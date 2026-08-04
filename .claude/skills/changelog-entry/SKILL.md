---
name: changelog-entry
description: Use when writing, editing or reviewing a CHANGELOG.md entry, when a pull request needs a changelog line, when deciding if a change is breaking or needs a migration note, or when a changelog conflict appears while rebasing stacked branches.
---

# Changelog entry

A changelog is written for the person who upgrades. How the change was made, what it cost, and which
files moved belong in the issue and the pull request.

## The shape of an entry

```
- [**Breaking:** ]<present-tense verb> <what the user gets> ([#<issue>])
```

```markdown
### Changed

- **Breaking:** drop `file` from `get_apex_log_summary` in favour of the scalar `topMethodsSelfPercentage` ([#86])
- Reduce every tool response with no fact lost: `execute_anonymous` by 30%, `get_apex_log_summary` by 27% ([#86])

<!-- Unreleased -->

[#86]: https://github.com/owner/repo/issues/86
```

- **One line, one sentence.** No sub-bullets. No semicolon joining two facts.
- **Present tense.** "Add", "Reduce", "Refuse" — not "Added", "Reduced".
- **Breaking entries first** in their section, prefixed `**Breaking:**`.
- **Sections in this order:** Changed, Added, Removed, Fixed.
- **A reference link on every substantial entry**, defined under `<!-- Unreleased -->` at the end of
  the file. Never an inline URL.

## What earns an entry

One entry per user-visible change, not one per commit. If a user of the released package cannot see
it, it gets no entry: a refactor, a renamed internal helper, a test, the mechanism behind a fix.

Give the result, not the method. A number earns its place when the size **is** the result
("Reduce ... by 31%"); how it was measured does not.

Already-unreleased work: edit the existing entry. A change nobody has received is not a change.

No issue fits? File one, then reference it.

## Wrong, then right

| Wrong | Right |
| --- | --- |
| `- Removed destructiveHint from three tools, since the spec says it is meaningless when readOnlyHint is true` | no entry — the user sees no difference |
| `- Replaced ten per-category properties with one z.partialRecord, cutting ~844 to ~428 tokens` | fold the result into the one user-facing entry |
| `- Reduced the cost by 31% ([#87](https://.../87))` | `- Reduce the cost by 31% ([#87])`, plus a reference definition |

## Versions and migration

- A version heading is added when the release is tagged, with an absolute date: `## [1.0.0] - 2026-03-20`.
  Until then everything sits under `## [Unreleased]`.
- **Major** is forced by behaviour that changes for someone who upgrades and changes nothing else.
- When upgrading needs an action, add a migration note under `## [Unreleased]` that points at it.

## Stacked branches

Every branch in a stack writes into the same `## [Unreleased]` section, so a rebase conflicts there.
Keep both sides. Losing the other branch's entry is silent, and review will not catch it.
