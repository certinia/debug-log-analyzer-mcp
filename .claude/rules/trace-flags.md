---
paths:
  - "src/salesforce/traceFlags.ts"
  - "src/salesforce/anonymousApex.ts"
  - "src/tools/executeAnonymous.ts"
---

# Trace flags vs the `DebuggingHeader`

Tested in a scratch org on 2026-09-30. Table and method: https://github.com/certinia/debug-log-analyzer-mcp/issues/207#issuecomment-5911585976. Do not re-test unless Salesforce changes.

- The header beats a `USER_DEBUG` flag, in the returned log and in the stored log.
- A `DEVELOPER_LOG` flag (Developer Console) beats the header. The whole set wins, not each category.
- Salesforce stores an `ApexLog` row only when the running user has an active flag. The header alone stores nothing, so there is no log id.
- An active flag at any level stores the row. The header still sets the run's levels.
- A flag on another user, or an expired flag, stores nothing for this user.
- A flag with a 1-minute expiry is accepted and works. A `StartDate` in the past is accepted.
- Salesforce refuses a second flag whose window overlaps one the entity already has: `FIELD_INTEGRITY_EXCEPTION`, "already being traced". A flag with no `StartDate` overlaps even an expired flag, so always set one.
- The overlap rule is per log type: a `DEVELOPER_LOG` flag does not block a `USER_DEBUG` create, and a flag that starts later does not block one for now.
- With no header, the returned log is empty, and the stored log carries the flag's levels. An empty `<DebuggingHeader/>` does the same. A `debugLevel` preset such as `DEBUGONLY`, which `sf apex run` and the VS Code extension send, beats the flag like a categories header. Tested 2026-10-09: https://github.com/certinia/debug-log-analyzer-mcp/issues/230
- So no header form defers to the flag and returns the log: to run at a flag's levels, read its `DebugLevel` and send them.
- A flag also logs the user's other traffic (e.g. `/aura` requests) while it lives.
- `CLASS_TRACING`: a flag on a class is accepted, and a second whose window overlaps is refused the same way. Tested 2026-10-09 (#211).
- A class or trigger flag stores no log itself: it only overrides the levels of that code's work, in logs a user flag stores. Documented, not tested: https://help.salesforce.com/s/articleView?id=platform.code_debug_log_classes_setup.htm
- An edit can end a flag early, but only to a future time: an `ExpirationDate` 5 seconds ahead is accepted; one in the past, or not after `StartDate`, is refused with `FIELD_INTEGRITY_EXCEPTION`. Tested on a `CLASS_TRACING` flag in the psa scratch org 2026-10-10 (#213); `USER_DEBUG` not tested. So a delete stops logging now; an edit cannot.
- A delete of a flag already deleted fails with `INVALID_CROSS_REFERENCE_KEY` when sent by id (`tooling.destroy(type, id)`); a list of ids goes to an endpoint the Tooling API lacks and fails with `NOT_FOUND`. Tested in the psa scratch org 2026-10-10 (#237).
