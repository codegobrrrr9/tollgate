---
name: tollgate
description: Governs the review loop around any reviewer. Keeps a findings ledger for a branch (what was found, fixed, waived, re-flagged), enforces a round cap by escalating to a human instead of running round 4, 5 and beyond, and analyses any GitHub PR for review rounds, repeated findings and findings that were already visible in round one. Use whenever you review code, answer review comments, run a review/fix loop, or the user asks how many review rounds a PR took, why review keeps finding new things, or says /tollgate.
license: MIT
metadata:
  author: codegobrrrr9
  version: "0.1.0"
  homepage: https://github.com/codegobrrrr9/tollgate
---

# tollgate

A review loop has three ways to go wrong: the reviewer drips findings out one round at a time, the author
says "addressed" without proof, and nobody stops it at round 7. tollgate is the ledger that makes each of
those visible. It is not a reviewer and it fixes nothing.

## Rules

**If you are the reviewer**
1. **One pass, everything.** Report every finding you would raise in a single pass, ranked, each one marked
   `--blocking` or `--nit`, each with the file and line. Do not hold findings back for the next round.
2. **Record each with `tollgate add`**: `tollgate add --file src/a.js --line 42 --text "..." --blocking`.
   Pass the exact source line with `--code` when you have it. The tool detects repeats itself.
3. **Never re-raise a resolved or waived finding without saying why.** If `add` answers `REOPENED: fix
   incomplete`, the fix did not work: say so. If it refuses a waived finding, you need a `--reason` the
   waiver no longer holds.

**If you are the author**
4. **Answer every open finding** with `tollgate resolve <id> --fixed <sha>` (the commit that fixes it) or
   `--waive "<reason>"` (at least five characters, an actual reason). Never write "addressed" or "fixed"
   in a message unless the ledger shows it.
5. **After pushing fixes, run `tollgate round`.** That is what moves the loop forward and what the cap counts.

**Both**
6. **Run `tollgate status` before you say a review is done**, and end your message with its line.
7. **When status says ESCALATE, stop.** Do not start another round. Say you escalated, how many blocking
   findings are open (the number), and list them. A human decides.
8. **Never edit `.tollgate/` by hand.** It is an append-only log.
9. **To analyse an existing PR**: `tollgate pr <number> --repo owner/name` (add `--dir .` inside a clone
   for the visible-in-round-one count). Quote its numbers; do not summarise them from memory.
10. **Ask before adding the GitHub Action** to a workflow in someone's project.

## Commands

```
tollgate add --file f --line n --text "..." [--code "<line>"] [--nit|--blocking] [--reason "..."]
tollgate resolve <id> --fixed <sha> | --waive "<reason>"
tollgate round            start the next round (after pushing fixes)
tollgate status           one line: round, verdict, open, fixed, waived, reopened, repeats
tollgate gate             exit 0 PASS, 1 BLOCK, 3 ESCALATE  (cap 3, or .tollgate.json, or --cap)
tollgate pr <n|url>       analyse a GitHub PR: rounds, re-flags, visible in round one
tollgate scan --repo o/r  the same over the last 180 days of a repo
```

Verdicts: **PASS** nothing blocking is open. **BLOCK** blocking findings are open within the cap.
**ESCALATE** blocking findings are open past the round cap: a human decides.

The definitions (round, finding, re-flag, visible in round one) are in
[`references/method.md`](references/method.md). The cap of 3 is a default, not a researched optimum.

## Final message shape

```
Review loop: tollgate feature/x · round 2 of cap 3 · PASS · open 0 (0 blocking) · fixed 4 · waived 1 · reopened 1 · repeats 0
```

When it is not PASS, list the open findings by id and say what happens next (fix, waive, or escalated).
