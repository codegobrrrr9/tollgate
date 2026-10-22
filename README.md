<div align="center">

# 🚧 tollgate

**A review loop needs a ledger and a stop.**

Your agent reviews, another one fixes, the reviewer finds more. tollgate keeps the list of what was found, fixed, waived and raised again, counts the rounds, and at the round cap hands the decision to a human instead of running round 7. One zero-dependency file, a GitHub Action, and an agent skill.

[![test](https://github.com/codegobrrrr9/tollgate/actions/workflows/test.yml/badge.svg)](https://github.com/codegobrrrr9/tollgate/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

On five public repos, **46% of the findings that came after round one were on lines already there, unchanged, in round one.** Most PRs get one round; 12.9% get three or more. [The numbers, and what they don't say](#does-it-work).

## For your coding agent

Paste this into Claude Code, Codex, Cursor or Gemini CLI:

```
Install the tollgate skill from https://github.com/codegobrrrr9/tollgate, refer to the repo's AGENTS.md.
```

From then on the reviewer agent records every finding in one pass, the author agent answers each with a commit sha or a written reason, and the final message ends with one line:

```
tollgate  feature/cart  ·  round 2 of cap 3  ·  PASS  ·  open 0 (0 blocking)  ·  fixed 3  ·  waived 1  ·  reopened 1  ·  repeats 0
```

No install, any GitHub PR:

```bash
npx --yes --allow-git=all github:codegobrrrr9/tollgate pr 17480 --repo sveltejs/kit
```

```
tollgate  PR #17480  ·  20 findings  ·  14 rounds (cap 3)  ·  0 bot, 20 human
OVER CAP
  round 1  dcce00c    1 findings  <reviewer>
  round 2  c8f8ad5    1 findings  <reviewer>
  …
  round 8  a035f50    3 findings  <reviewer>
  …
  round 14 a2b8ccc    5 findings  <reviewer 2>
late findings (round 2+): 19
  visible in round one: 14  new code: 5  unknown: 0
  re-flagged: 1
    visible: round 3 documentation/docs/…/60-adapter-cloudflare.md:82 "```suggestion You can use the Wrangler CLI to deploy…"
```

A documentation PR, one human reviewer leaving a suggestion per push, and fourteen of the nineteen later findings were on lines that were there in round one. (Reviewer handles are removed here; run it to see them. This is a person, not an agent: the loop is older than agents.)

## What a loop looks like with a ledger

```
$ tollgate add --file src/cart.js --line 42 --text "Handle the empty cart before indexing items[0]" --blocking
added t-1 (round 1)
$ tollgate resolve t-1 --fixed 4f2a9c1
t-1 fixed in 4f2a9c1
$ tollgate round
round 2
$ tollgate add --file src/cart.js --line 42 --text "Empty cart is still not handled before indexing items[0]"
REOPENED t-3: fix incomplete, t-1 was fixed in 4f2a9c1
```

The fix did not work, and the ledger says so instead of opening a fresh finding that looks new. After the next two rounds:

```
$ tollgate status
tollgate  feature/cart  ·  round 4 of cap 3  ·  ESCALATE  ·  open 2 (1 blocking)  ·  fixed 2  ·  waived 0  ·  reopened 1  ·  repeats 0
  t-4  blocking src/cart.js:90  "Totals ignore the discount code when the cart has one item"  (round 4)
$ tollgate gate; echo $?
3
```

| Verdict | Meaning | Exit |
|---|---|---|
| **PASS** | nothing blocking is open | 0 |
| **BLOCK** | blocking findings are open, within the cap | 1 |
| **ESCALATE** | blocking findings are open past the round cap: a human decides | 3 |

Re-flags are always recorded, never refused. A repeat of an **open** finding is counted against it. A repeat of a **fixed** finding reopens it as `fix incomplete` and keeps the original sha. A repeat of a **waived** finding needs a stated reason, and the waiver is shown beside it. Wording alone only counts as a repeat across rounds or at the same line: two different findings on one file in one pass are both kept.

In Claude Code, the Stop hook blocks the agent finishing while blocking findings are open (once per stop attempt, so it informs and never traps). Past the cap it does **not** force another round: it lets the agent stop, and asks once that the final message says it escalated, with the number of findings still open.

## In CI

```yaml
on: [pull_request, pull_request_review]
permissions:
  contents: read
  pull-requests: read
jobs:
  tollgate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0       # adds the visible-in-round-one count
      - uses: codegobrrrr9/tollgate@v1
        with:
          cap: 3
          fail-on: never       # block | escalate | never (default never: report only)
```

It reads the PR's review threads, writes a summary to the job page, and exposes `verdict`, `rounds`, `open`, `blocking` and `reflags` as outputs. Resolution of a thread is only in GitHub's GraphQL API, so the job token does the reading. A thread whose first comment starts with `nit` or `optional` does not count as blocking. It posts nothing to the PR.

## Does it work

**What it found.** Review comments over 180 days on five public repos chosen for review volume, no model runs, definitions fixed before the data was read ([method](skills/tollgate/references/method.md), [full tables](benchmarks/results.md), raw rows in `benchmarks/scan.jsonl`):

| Repo | PRs | 3+ rounds | Most rounds | Late findings visible in round one | Late findings re-flagged |
|---|---|---|---|---|---|
| withastro/astro | 266 | 8.6% | 9 | 54.6% | 1.4% |
| sveltejs/kit | 396 | 17.9% | 14 | 55.6% | 4.9% |
| TanStack/query | 280 | 4.3% | 5 | 59.4% | 15.1% |
| colinhacks/zod | 139 | 25.9% | 10 | 13.7% | 4.8% |
| vitest-dev/vitest | 220 | 11.8% | 11 | 45.0% | 11.3% |
| **Pooled** | **1,301** | **12.9%** | 14 | **46.3%** (n=1,320) | **6.1%** |

Most PRs are one round (71.6%); 4.0% reach five or more. A **round** is a distinct commit a reviewer was looking at. **Visible in round one** means the commented line was unchanged between round one's commit and the finding's own commit. Humans and bots differ: 55.0% of human late findings were visible in round one against 27.3% for bots, and 10.9% of bot late findings repeat an earlier one against 3.3% for humans.

**Would a cap have helped?** 82 PRs (6.3%) went past round 3. They produced 418 findings after it. Of those, **33.8% were on code visible in round one** and **66.2% were on code the fixes had just changed**. A cap that simply dropped them would have silenced mostly findings about new code, so tollgate does not drop them: at the cap it escalates to a human.

**What the spread says.** The visible share runs from 13.7% to 59.4%. All of zod's inline review comments in this window came from bots, and its late findings are mostly on new code, which is what a reviewer looking at each new push would produce. The loop is real on some repos and not on others, which is why `scan` exists: run it on yours.

**A benchmark bug, found and fixed.** The three views (all, human, bot) shared finding objects, so a re-flag mark from one view could leak into the next. The headline "all" numbers were unaffected (that view runs first on clean objects), one count moved (kit's bot re-flags, 8 to 7), a regression test now fails on the old behaviour, and the whole run was repeated frozen from the cache with identical headline results.

40 tests build real git repos with real PR refs, a fake GitHub API for the REST and GraphQL paths, and drive the hook with real hook JSON.

## How it decides

- **Round**: a distinct `original_commit_id` among a PR's inline review comments, in order of first comment. Not `commit_id`: GitHub moves that to the current head while a comment still applies.
- **Finding**: a top-level inline comment on a line. Replies and file-level comments are not findings. Bots are marked, never dropped.
- **Re-flag**: a later finding on the same path with the same line text, or at least half the same words.
- **Visible in round one**: `git diff -U0` between round one's commit and the finding's own commit does not touch the commented line.

Every rule, the exclusions and the pre-registered go/no-go threshold are in [`references/method.md`](skills/tollgate/references/method.md).

```bash
tollgate pr <n|url> [--repo o/r] [--dir .]    analyse one PR (--dir anchors against a local clone)
tollgate scan --repo o/r [--days 180]         the same over a repo
tollgate add | resolve | round | status | gate    the live ledger, .tollgate/ledger.jsonl
```

## Honest limits

- It counts review comments that exist. It does not know whether a finding was right, or whether a many-round PR was a bad PR. Some deserve many rounds.
- "Visible in round one" is where a finding is anchored, not a verdict that the reviewer should have caught it.
- Five public repos picked for review volume are not a sample of GitHub, their bots are not Anthropic's pipeline, and nothing here measures Anthropic's own figures.
- The cap of 3 is a default. It comes from one builder's account of Anthropic's code-review post, which this repo's author had not read in the original when this was written.
- A repeat is found by shared words on the same path, so it can merge two distinct findings. Every pair is shown with both quotes.
- A file renamed between rounds counts as new code, which only lowers the visible share. Force-pushed commits are `unknown`, counted and left out of the percentages.
- The local ledger only helps if the agent uses it. The Stop hook enforces that for Claude Code only, and only once per stop attempt.
- GitHub only. Reading thread resolution needs a token.

## Install by agent

| Agent | How |
|---|---|
| **Claude Code** | `/plugin marketplace add codegobrrrr9/tollgate` then `/plugin install tollgate@tollgate`. Adds `/tollgate` and the Stop hook. |
| **Codex** | Copy `skills/tollgate/` to `~/.codex/skills/tollgate/` and append the Rules from [`AGENTS.md`](AGENTS.md). |
| **Cursor** | Copy [`.cursor/rules/tollgate.mdc`](.cursor/rules/tollgate.mdc) and `tollgate.js` into the project. |
| **Gemini CLI** | `gemini extensions install https://github.com/codegobrrrr9/tollgate` |
| **GitHub Copilot** | Copy [`.github/copilot-instructions.md`](.github/copilot-instructions.md). |
| **Anything else** | The Rules from [`AGENTS.md`](AGENTS.md) plus `tollgate.js` in the project. |

## Credits

This came out of the conversation after Anthropic wrote about how it changed code review when Claude started writing most of its own code, and the rule builders took from it: cap agent review loops. Anthropic's own Code Review product is a *reviewer* (parallel agents that verify findings before posting); tollgate is not, and governs the loop around any reviewer, that one included. [openqodex](https://github.com/openqodex/openqodex) reviews before you push; same neighbourhood, different job. Same family as [seatbelt](https://github.com/codegobrrrr9/seatbelt), [cheapskate](https://github.com/codegobrrrr9/cheapskate), [alibi](https://github.com/codegobrrrr9/alibi), [shortlist](https://github.com/codegobrrrr9/shortlist) and [grudge](https://github.com/codegobrrrr9/grudge).

## License

MIT. Star ⭐ if it stopped a round 7.
