---
name: incident-triage
description: Playbook for triaging a production incident end-to-end: reproduce, assess blast radius, stabilize, and write the postmortem.
---

# Incident Triage Playbook

When you pick up an incident report, work this checklist in order. Use `task.board`
to track each step so the rest of the squad can see your progress.

1. **Reproduce.** Use the terminal to run the failing command or hit the failing
   endpoint from the sandbox. Record the exact error, exit code, and timestamp.
2. **Assess blast radius.** Check logs and metrics: how many users/services are
   affected? Is data at risk? Tag the incident SEV1-SEV4.
3. **Stabilize.** Apply the safest mitigation first (rollback, feature flag, rate
   limit, restart). Dangerous commands (rm, force-push, reboot-class actions)
   REQUIRE human approval — file them and wait.
4. **Verify.** Re-run the reproduction from step 1 and confirm recovery.
5. **Postmortem.** Write a short report: what happened, why, timeline, impact,
   fix, and one concrete prevention action. Share it with the team mailbox.

Never mark an incident resolved until step 4 passes twice in a row.
