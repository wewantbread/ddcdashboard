# Program Manager MVP acceptance matrix

This matrix is the local completion gate for the Program Manager MVP. It covers
the behavior required for a reliable planning and coordination role without
promoting it into an executor or a source of truth.

| ID    | Acceptance requirement                                                                                                                                         | Proof                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| PM-01 | Produces plans and status reports with objective, scope, milestones, owners, blockers, dependencies, and acceptance criteria.                                  | Contract catalog plus focused role-eval tests                 |
| PM-02 | Distinguishes Confirmed, Inferred, Assumption, Risk, Unknown, and Recommended verification step; unknown or stale state cannot become a real completion claim. | Output contract and state fixtures                            |
| PM-03 | Requests work through structured handoff packets with target, trigger, input, expected output, owner, approval requirement, failure mode, and recovery.        | Handoff contract and unit tests                               |
| PM-04 | Emits non-secret telemetry on `program_manager_telemetry` without credentials, cookies, browser/session data, or private notes.                                | Telemetry unit tests and type/build proof                     |
| PM-05 | Fails closed for unsafe indirect execution and requires `security=deny`, `ask=always`, and `askFallback=deny` for `exec`.                                      | Static repository evaluator and focused tests                 |
| PM-06 | Exposes stale-work signals and preserves explicit unknown metadata in canonical state fixtures.                                                                | Efficiency contract and state validation                      |
| PM-07 | Static contracts run deterministically from the CLI with no private operator state.                                                                            | `node scripts/agent-role-eval.mjs --contracts-only --json`    |
| PM-08 | Live evaluation is opt-in/manual or local-only; scheduled CI does not hydrate live secrets.                                                                    | Workflow test and actionlint                                  |
| PM-09 | Changed source is formatted, linted, tested, built, and diff-clean.                                                                                            | Focused tests, formatter, lint, build, and `git diff --check` |

Completion means every row has current local evidence. A green check suite
alone is not a substitute for the behavior and security proof above.
