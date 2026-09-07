# Migrating from 1.x

The tools describe themselves, so an agent reads the new parameters and fields off the wire. Two
things do not arrive that way: the tool names in your permission lists, and the flags you start the
server with. The [changelog](CHANGELOG.md) lists what else moved.

## Tool names

Every tool was renamed - see [Naming Tools and Fields](DEVELOPING.md#-naming-tools-and-fields).

| 1.x                            | 2.0                            |
| ------------------------------ | ------------------------------ |
| `get_apex_log_summary`         | `apexlog_get_summary`          |
| `analyze_apex_log_performance` | `apexlog_list_slow_operations` |
| `find_performance_bottlenecks` | `apexlog_list_limit_risks`     |
| `execute_anonymous`            | `apexlog_execute_anonymous`    |

Update wherever you name a tool yourself:

- Tool allow and deny lists. Some clients qualify a name with the server, so `execute_anonymous` may appear as `mcp__apex-log-mcp__execute_anonymous`.
- Prompts, agents and skills.

## Server flags

`--allowed-orgs` is ignored and warns on stderr. Delete it. The type of the org decides instead.

| 1.x                             | 2.0                                                        |
| ------------------------------- | ---------------------------------------------------------- |
| No flag (tool hidden)           | No flag - the tool works against non-production orgs       |
| `--allowed-orgs ALLOW_ALL_ORGS` | No flag. Add `--allow-production-orgs` to target production |
| `--allowed-orgs <org>,<org>`    | No flag. Org type decides, not an org list                 |

`ALLOW_ALL_ORGS` no longer implies consent to run against production. To stop Apex running at all,
add `--no-apex-execution`; the log analysis tools keep working.
