# Squad Round 3 — Evidence-Closure Invariant on the Great Scale

**Status:** implementation candidate / verification pending. This note deliberately separates changes committed from tests actually executed.

## 1. Reconnaissance snapshot

The source tree already contains a sizeable multi-agent runtime: parallel squads and deep review in `avrone/trinity.py`, persistent event logs, per-agent filesystem/memory, a thermal/resource governor, fleet dispatch, and a guarded self-evolution proposal loop. The new round focuses on weak transitions between those modules rather than raising worker count blindly.

Round-3 changes on this branch:

- Safe numeric settings parsing: malformed values, NaN/infinity, and invalid negative/zero concurrency values fall back to defaults.
- OSINT metrics tolerate malformed JSONL, non-object JSON values, invalid event shapes/UTF-8, unreadable logs, and bounded file counts/sizes.
- Read-only `runtime_preflight` reports workspace/data readiness, free disk, configured/actual runner identity, capability toggles, and resource limits without starting containers or changing privileges.
- Regression tests cover the config, OSINT, and preflight edge conditions; Grok Bot also gains Node unit tests for evolution-event parsing.
- Added `squad-edge-review` and `long-run-recon` skills with explicit evidence gates, checkpointing, and authorized-scope boundaries.
- Added a separate pull-request source-check workflow to Grok Bot, independent of the expensive Docker/Ollama live-stack test.

## 2. Four-lane review

### Lane A — Test coverage
1. Exercise invalid and non-finite environment values, preserving intentional `agent_timeout=0` semantics while requiring positive worker/step counts.
2. Exercise malformed/non-object JSONL events, invalid UTF-8 and oversized files; test runtime preflight read-only behaviour and path readiness.

**Acceptance evidence:** full Python matrix and Node unit tests must execute on a real runner. Files merely existing in a PR do not prove that the tests pass.

### Lane B — Tools and environment
1. Add the read-only `runtime_preflight` diagnostic for disk/path/runner/settings visibility.
2. Add a pull-request source-test lane for Grok Bot that separates deterministic offline tests from its model/container integration suite.

**Boundary:** preflight does not create directories, install packages, start a container, access the Docker socket, or grant host privileges.

### Lane C — Agent skills
1. `squad-edge-review` requires an explicit scope, reviewer, reproducible test command, verified diff, and human approval before merge.
2. `long-run-recon` requires authorized single-target scope, durable checkpoints, finite global budgets, and a recovery record.

### Lane D — Robustness and self-evolution
1. Parse numeric settings defensively so a typo or `NaN` cannot poison boot or worker configuration.
2. Bound OSINT log aggregation and skip malformed entries instead of letting one damaged file destroy a report.

**Not loosened:** the existing evolution loop's iteration/time ceilings, private-target recon controls, signed fleet capability checks, and privileged operation allowlists.

## 3. Great Scale mapping — XCV candidate: Evidence-Closure Invariant

This is an operational mapping, not a claim of new physical law.

Let the hidden execution state be (x \in X). The observable CI receipt is

\[
\rho = (repo, sha, run\_id, attempt, job\_id, runner\_id, command, exit, artifact\_digest).
\]

Define the observation projection

\[
P_{obs}: X \rightarrow \mathcal{R} \cup \{\bot\},
\]

where \(\bot\) means the system did not emit enough evidence to identify what executed. The shared phase marker is

\[
\theta_0=(repo, sha, run\_id, attempt).
\]

The current failed Actions records have `runner_id=0` and empty step lists. Therefore the test command and its exit status were never observed in the run record. The correct source-verification conclusion is **unknown / infrastructure blocked**, not “tests passed” and not “the code failed a test.”

Define the evidence-coherence gate

\[
C(\rho)=I_{sha}\,I_{runner}\,I_{steps}\,I_{exit}\,I_{artifact},
\]

where each indicator is 1 only when the tested SHA matches the PR head, a real runner is assigned, the required test steps exist, the captured exit code is zero, and any required artifact/receipt matches the same run and SHA. A mergeable candidate requires (C=1) for all required gates. Missing fields do not get guessed or synthesized.

### Projection → involution → quotient

1. **Projection:** reduce internal activity to a receipt containing the exact tested commit, runner/job identity, command, exit and artifacts. A missing receipt projects to \(\bot\).
2. **Involution (replay):** replay the same deterministic test against the same commit and dependency/runtime profile. A valid replay returns to an equivalent verified state; if outcomes differ, classify the pair as flaky or environment-sensitive and investigate rather than averaging it into a pass.
3. **Quotient:** identify two runs as equivalent only if the commit, test command, relevant runtime/dependency profile, and evidence contract match. Run IDs may differ; the tested source and test conditions may not.

This closes the last connection between **agent output → verifiable receipt → governance gate**. More agents or a longer wall-clock run do not add scientific information if the observer cannot establish what actually executed.

## 4. Resource / thermal invariant

AVRONE already has a governor that reads load, memory, disk and thermal pressure and clamps parallelism. In simplified form:

\[
p^*=p_{min}+\operatorname{round}\big((p_{max}-p_{min})\,\min(g_{load},g_{mem},g_{disk},g_{temp})\big),
\]

with (1\le p^*\le p_{max}) and each health factor (g\in[0,1]). The preflight tool exposes configuration and disk readiness; the governor remains responsible for live throttling.

The system should optimize **verified progress per bounded resource budget**, not duration alone. A safe long run uses checkpoint/replay and a generous finite budget; removing every deadline creates a hang and resource-exhaustion mode, not a proof of greater reach. The documented per-agent `agent_timeout=0` remains an operator setting, but the self-evolution loop keeps its hard iteration and duration ceiling.

## 5. Measurable success criteria

A round is done only when:

1. The Python 3.11 and 3.12 offline suites complete on an assigned runner with exit code 0.
2. The Node syntax/unit suite completes with exit code 0.
3. The live Compose boot and Grok Bot ↔ AVRONE bridge tests produce current, run-correlated receipts for the exact tested SHA.
4. Two worker traces demonstrate overlapping execution, not just a configured worker count.
5. No private target, arbitrary host-root shell, public unauthenticated control API, or unbounded self-evolution capability is enabled by default.
6. The final diff is reviewed; the PR is not marked ready or merged before the above evidence exists.

### Current measurement

At the latest observed retry, GitHub Actions was listed operational on the public status page, but the target repo jobs still reported `runner_id=0` and no steps. This narrows the issue to an unexplained per-job runner/dispatch condition; it does not identify a root cause. Full-suite and live-stack verification remain pending.
