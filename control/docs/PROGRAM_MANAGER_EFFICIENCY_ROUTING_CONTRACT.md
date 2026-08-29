# Program Manager efficiency and routing contract

Use local-first evaluation for ordinary planning and status work. Sensitive
context requires explicit hosted approval and Control Director escalation;
Program Manager must not silently route sensitive context to a hosted model.

Track stale-work signals including stale milestone count, stale task count,
blocker age, dependency age, unknown count, approval gate count, completion claim
review count, and last status report age.

Cost/latency controls include bounded `maxTokens`, low `text_verbosity`, and
short `cacheRetention`; avoid duplicate analysis and prefer existing canonical
docs/state. A local-first route is the default, while hosted approval is a
separate gate.

Regression requirements:

- scheduled static eval runs `node scripts/agent-role-eval.mjs --contracts-only --json`;
- a configured-agent static eval runs `node scripts/agent-role-eval.mjs --agent program-manager --json`;
- live eval is opt-in and local-only, never a scheduled secret-bearing lane;
- the safety boundary, full output, unsupported completion, handoff telemetry,
  efficiency routing, and stale-work scenarios are covered before promotion.
