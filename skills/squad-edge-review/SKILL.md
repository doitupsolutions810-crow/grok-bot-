---
name: squad-edge-review
description: Coordinate evidence-backed parallel testing, tooling, skill, and resilience reviews without weakening safety gates.
---
1. Create four independent work lanes: test coverage, deterministic tools, agent skills, and resilience. Give each lane two explicit changes and a named reviewer.
2. Inspect `runtime_preflight`, `self_scan`, and `capabilities_report` before touching an environment. Record what is actually enabled instead of inferring capabilities.
3. Use `codex_search` and `osint_metrics` to identify repeated errors and stale evidence. Treat malformed records as input to test, not a reason to hide the failure.
4. Keep tests offline and deterministic wherever possible. For each production change, add at least one regression case for invalid types, missing resources, cancellation, and resource caps as relevant.
5. Submit each proposed patch through `evolve_propose`; the proposal must pass the configured full deterministic test gate in an isolated worktree before it can be listed as accepted.
6. Check `evolve_list` and inspect `evolve_diff` for every accepted proposal. Reject patches that claim tests passed without captured command output or that disable existing guards to improve a score.
7. Save a concise run summary with `memory_save` and publish the evidence bundle with `artifact_save`. Separate verified results, blocked checks, and hypotheses.
8. Merge only after a human reviews the final combined diff and a real CI run is green. Never grant root, shell, network, or deployment capabilities to a worker merely to make the round complete.
