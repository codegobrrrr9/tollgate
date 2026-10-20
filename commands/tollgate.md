---
description: Review-loop status for this branch, or the review rounds of a GitHub PR. Shows the ledger line and the open findings; with a PR number, runs the analysis.
allowed-tools: Bash(node:*), Bash(git:*), Read
---

1. If `$ARGUMENTS` is empty, run `node ${CLAUDE_PLUGIN_ROOT}/skills/tollgate/scripts/tollgate.js status` from the
   project root (if that path does not exist, find `tollgate.js` under the installed tollgate skill).
   Quote the status line and list the open findings. If there is no ledger yet, say so and offer to start one.
2. If `$ARGUMENTS` is a PR number or URL, run `node ${CLAUDE_PLUGIN_ROOT}/skills/tollgate/scripts/tollgate.js pr $ARGUMENTS --dir .`
   and quote the rounds, the re-flags and the visible-in-round-one count exactly as printed.
3. If the verdict is ESCALATE, say so and do not suggest another round.
