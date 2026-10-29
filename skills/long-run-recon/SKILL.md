---
name: long-run-recon
description: Run deeper authorized reconnaissance and long-duration agent rounds with checkpoints, bounded budgets, and resilience evidence.
---
1. Inspect `runtime_preflight`, `self_scan`, and `capabilities_report` before assigning reconnaissance. Confirm the actual runner, filesystem access, network policy, and node limits.
2. Scope every external probe to one named public domain that the operator is authorized to assess. Use `osint_domain` for a bounded public profile and `osint_metrics` to audit prior probe activity.
3. Use `port_scan` only when explicit authorization is present and the configured target gates allow the named host. Do not expand a single-host task into ranges, broad crawling, private targets, credential discovery, or a user-targeting investigation.
4. Plan long work as phases with a fixed success criterion, checkpoints, and a recovery note. A zero AVRONE_AGENT_TIMEOUT disables the per-agent deadline; prefer a deliberately generous finite deadline unless a human operator has reviewed the resulting hang/resource risk. Keep self-evolution within the hard iteration and time-budget ceilings.
5. After each phase, save only useful durable facts with `memory_save`; use `memory_recall` to reload the latest checkpoint after a restart. Do not store access tokens, raw credentials, or unredacted secrets in memory or artifacts.
6. If a phase fails, classify it as a policy refusal, missing capability, transport failure, malformed output, resource pressure, or code defect. Never work around a deny switch, host allowlist, missing authorization, or least-privilege boundary.
7. Send proposed code changes through `evolve_propose`, confirm them with `evolve_list`, and inspect `evolve_diff`. Require the complete offline suite and a live integration check where applicable before calling the phase verified.
8. Produce an `artifact_save` report with the exact scope, tools called, evidence timestamps, test command/output, resource limits, unresolved edges, and the next safe action. State explicitly when a runner or live service was unavailable.
