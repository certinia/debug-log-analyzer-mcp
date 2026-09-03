# Migrating from 1.x

## Tool names

Every tool was renamed — see [Naming Tools and Fields](DEVELOPING.md#-naming-tools-and-fields).

| 1.x                            | 2.0                            |
| ------------------------------ | ------------------------------ |
| `get_apex_log_summary`         | `apexlog_get_summary`          |
| `analyze_apex_log_performance` | `apexlog_list_slow_operations` |
| `find_performance_bottlenecks` | `apexlog_list_limit_risks`     |
| `execute_anonymous`            | `apexlog_execute_anonymous`    |

Update wherever you name a tool yourself:

- Tool allow and deny lists. Some clients qualify a name with the server, so `execute_anonymous` may appear as `mcp__apex-log-mcp__execute_anonymous`.
- Prompts, agents and skills.

Response fields changed too — see the [changelog](CHANGELOG.md).

## Governor limit figures

`used` is now the peak each limit reached, not the usage the transaction ended on. A counter falls
when the frame that spent it exits, so a 1.x figure could read below the ceiling a run had already
breached. Expect a counter to read the same or higher than 1.x did for the same log, in
`apexlog_get_summary.governorLimits`, its `limitsByNamespace`, and the limits
`apexlog_list_limit_risks` selects.

`heapSize` moves the other way on a log with more than one namespace. 1.x added each namespace's
figure together, and heap is a level and not a counter, so the total was never a sum. It is now the
highest figure any namespace reported, which is lower.

If you compare figures across versions, re-baseline them rather than treating either move as a
regression.

## Org access

`--allowed-orgs` is ignored and warns on stderr. Delete it.

| 1.x                             | 2.0                                                              |
| ------------------------------- | ---------------------------------------------------------------- |
| No flag (tool hidden)           | No flag — the tool works against non-production orgs             |
| `--allowed-orgs ALLOW_ALL_ORGS` | No flag. Add `--allow-production-orgs` to target production       |
| `--allowed-orgs <org>,<org>`    | No flag. Org type decides, not an org list                       |

`ALLOW_ALL_ORGS` no longer implies consent to run against production.
