---
name: research-squad
description: Playbook for running a multi-worker research mission: split the question, research in parallel, verify claims, and merge a cited brief.
---

# Research Squad Playbook

For questions that need breadth (comparisons, market scans, "what's the state of X"),
run a squad research mission instead of a single-agent answer.

1. **Frame the question.** Restate the request as a concrete, checkable question
   plus 2-4 independent subquestions. Deduplicate overlapping subquestions before
   spawning workers.
2. **Spawn workers.** Each subquestion gets one worker with browser + web.fetch.
   Workers must cite a URL for every factual claim. Failed workers are expected —
   the lead works around the gap rather than retrying forever.
3. **Verify.** The lead cross-checks the 2-3 most load-bearing claims by opening
   the cited sources directly. Drop any claim whose source doesn't check out.
4. **Merge.** One definitive brief: answer first, then evidence, then sources.
   Resolve contradictions explicitly; if two workers disagree, keep the better-
   sourced claim and note the disagreement.
5. **Ship.** Return the brief with a confidence estimate (0-100%) and list what
   could not be verified.

Use deep mode (adversarial review waves) when accuracy matters more than speed.
