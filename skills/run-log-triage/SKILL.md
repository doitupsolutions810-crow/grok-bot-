---
name: run-log-triage
description: Triage a failed or misbehaving AVRONE run from its Codex event log: find failing tool calls, reproduce, self-heal, and report.
---
1. Locate the log. Each run is one JSONL file at $AVRONE_DATA_DIR/runs/<run_id>.jsonl (default ./data/runs). If you
   were not given a run id, shell `ls -t "${AVRONE_DATA_DIR:-./data}/runs" | head` and take the newest.
2. python: read the file line by line with json.loads (skip lines that fail to parse). Pair every "tool.call" event with
   the next "tool.result" from the same agent. Flag results whose output starts with "ERROR", contains "Traceback",
   "[exit N]" with N != 0, or "timed out", plus any "error" events. Print agent, step, tool, args and the first 300 chars.
3. think: group the failures by tool and error message. Classify each group: missing dependency, bad arguments,
   policy refusal (disabled shell/network, allowlist, AVRONE_SELF_CHANGES=deny), environment fault, or a bug in AVRONE.
4. memory_recall the tool name and error text: a past incident may already have the fix.
5. Reproduce the first failure of each group with the same tool and the same args. Policy refusals are expected
   behaviour: never work around a deny, an allowlist or a disabled capability; report them as configuration.
   Never repeat destructive or outward-facing calls (writes outside the workspace, port_scan, posting data) just to reproduce.
6. Self-heal what is yours to fix:
   - missing package or command: env_install it (pip first, apt for system binaries), then re-run.
   - bad arguments: re-run with corrected args, and note which instruction or prompt produced them.
   - a bug in AVRONE itself: write a failing offline test, fix the code, and evolve_propose both (full file contents);
     evolve_list to confirm it passed the gate.
   If the same fix fails more than twice, stop and record it as unresolved.
7. resources: list any environment changes you made, so the report is complete.
8. memory_save key "incident.<tool>.<short-error>" with the cause and the fix, so the next agent finds it.
9. artifact_save "incident-<run_id>.md": timeline, failing calls (tool, args, error), root cause per group,
   what you fixed and how you verified it, what is still open, and any configuration a human must change.
