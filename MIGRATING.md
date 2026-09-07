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

## Operation categories

`kind` is gone from every response and parameter. A ranked row states `debugCategory`, the Salesforce
debug log category the platform stamped on the event, and `type`, the log's own event type. Both come
from the log rather than from this server, and every category on the wire is now spelled as the
`DebugLevel` field is — `database`, not `DB` — which is the spelling `apexlog_execute_anonymous`
already takes as input.

| 1.x `kind`       | 2.0 `debugCategory` | 2.0 `type`                                                |
| ---------------- | ------------------- | --------------------------------------------------------- |
| `codeUnit`       | `apexCode`          | `CODE_UNIT_STARTED`                                       |
| `managedPackage` | `apexCode`          | `ENTERING_MANAGED_PKG`                                    |
| `method`         | `apexCode`          | `METHOD_ENTRY`, `CONSTRUCTOR_ENTRY`                       |
| `systemMethod`   | `system`            | `SYSTEM_METHOD_ENTRY`, `SYSTEM_CONSTRUCTOR_ENTRY`         |
| `soql`           | `database`          | `SOQL_EXECUTE_BEGIN`, `QUERY_MORE_BEGIN`                  |
| `sosl`           | `database`          | `SOSL_EXECUTE_BEGIN`                                      |
| `dml`            | `database`          | `DML_BEGIN`                                               |
| `callout`        | `callout`           | `CALLOUT_REQUEST`                                         |
| `flow`           | `workflow`          | `FLOW_*`, `EVENT_SERVICE_*`                               |
| `workflow`       | `workflow`          | `WF_*`                                                    |

Two families move, because 1.x read a grouping meant for a timeline rather than the category the log
states. Visualforce events reported `APEX_CODE` or `SYSTEM` and now report `visualforce`; the
cumulative limit and profiling events reported `SYSTEM` and now report `apexProfiling`. Next Best
Action reported `systemMethod` and now reports `nba`. If you group or filter on the old values,
expect a Visualforce transaction to move most of its time.

Update wherever you name one: the `kind` parameter is now `debugCategory` and `type`, both arrays,
and so is `namespace`.

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
