# How tollgate counts

Every number tollgate prints comes from the definitions below. They were written down before any
benchmark data was read, and they do not change after the headline numbers are seen.

## Source

GitHub pull-request review comments, from `GET /repos/{owner}/{repo}/pulls/comments` (the repo-wide
list, 100 per call, ascending by creation time, saved page by page so a crawl resumes after a rate
limit) or `GET /repos/{owner}/{repo}/pulls/{n}/comments` for one PR. Unauthenticated GitHub allows
60 requests an hour; `GITHUB_TOKEN` or `GH_TOKEN` allows 5000.

## Finding

A **top-level inline comment on a line**: not a reply (`in_reply_to_id` empty), not a file-level
comment (`subject_type` is not `file`), with a path and a timestamp. Replies are discussion, not new
findings. Comments by bots (`user.type` is `Bot`, a login ending in `[bot]`) and comments whose body
is an AI review (starts with an HTML comment, `[AI:`, `### Bug:` and similar) are marked, never
dropped. Every aggregate is reported for **all** comments, **human** only and **bot** only; in each
view the rounds are rebuilt from that view's own findings.

## Round

A **distinct `original_commit_id`** among a PR's findings, numbered in order of the first comment on
it. Comments are grouped by `pull_request_review_id` first, each review takes the commit its reviewer
saw (the most common `original_commit_id` of its comments), and reviews that share a commit collapse
into one round, so two reviewers looking at the same commit are one round.

It is **not** `commit_id`. GitHub advances `commit_id` to the current head while a comment still
applies; `original_commit_id` stays fixed to the commit the reviewer was looking at. Real example:
vitest PR 11341 has three rounds (commits 4ce804d, 3294925, 610508f), and the round-3 comments carry
two different `commit_id` values (84d69e8, 610508f). Grouping on `commit_id` would split or merge
rounds depending on when the author pushed.

A comment with no `original_commit_id` makes its review a round of its own and the round is marked
`unknownCommit`.

## Re-flag

A finding in round 2 or later is a re-flag when an earlier finding on the **same path** either:

- points at the same line text (after trimming and collapsing whitespace, and at least 15
  characters long so `}` and `return;` do not match), or
- shares at least three words and at least half of the smaller word set. Words are the lowercased
  body with code blocks, HTML, URLs, paths and mentions removed, stop words dropped, and light
  stemming.

This can merge two distinct findings that use the same vocabulary. Every re-flag is reported as a
pair with both quotes so a reader can judge it.

## Visible in round one

For a finding in round 2 or later at (`path`, `original_line`, `original_commit_id`), compare the
file between **round 1's commit** and **the finding's own commit** with
`git diff -U0 --no-renames <round1> <own> -- <path>`. If the commented line falls inside an added
range, the line was written or changed after round one: **new**. If not, it was already there,
unchanged, when round one ran: **visible**.

- A file that did not exist in round 1 is **new** (a rename between rounds is therefore counted new,
  which can only lower the visible share).
- A deleted-side comment, a missing line number, or a commit that is not in the local clone
  (force-pushed away, or not fetched) is **unknown**. Unknown findings are counted and shown, and left
  out of every percentage.
- The commits come from `git fetch origin +refs/pull/N/head:refs/tollgate/pr/N`. One missing ref
  aborts a whole fetch, so the tool bisects the batch.

This measures **where a finding is anchored**, not whether it is valid. A finding on code that was
visible in round one may be a real bug the reviewer missed, a new insight, or a repeat. tollgate does
not say which.

## Window and boundary

`scan` reads the last `--days` days (default 180). A PR whose first comment falls in the first 14
days of the window may have lost earlier rounds to the `since` filter, so those PRs are dropped from
every figure. The number of PRs dropped is not hidden: `prsWithComments` and `prsInWindow` are both
reported.

## Verdict (single PR)

- `OVER CAP`: more rounds than the cap (default 3, `--cap` or `.tollgate.json`).
- `LOOPING`: three or more rounds and either the findings after round one are at least as many as in
  round one, or at least a quarter of them are re-flags.
- `CONVERGING`: otherwise.

The cap of 3 is a default, not a researched optimum. It is the figure one builder reports from
Anthropic's code-review writeup; the primary article has not been read by this tool's author at the
time of writing.

## The go / no-go rule used to decide whether to build the gate

Pooled over repos with at least 100 PRs carrying inline review comments, the loop-governing half of
tollgate (ledger, gate, Stop hook, Action) is built only if **both** hold:

1. at least 10% of those PRs reach 3 or more rounds, and
2. at least 25% of round-2+ findings with known anchoring are visible in round one, **or** at least
   10% of round-2+ findings are re-flags.

The thresholds are judgement calls fixed before the data was read.

## What this does not tell you

- Whether a finding was right.
- Whether a PR with many rounds was a bad PR; some deserve many.
- Anything about reviews outside GitHub, or comments left as a top-level PR comment instead of inline.
- Anything about private repos unless you run it on them with your own token.
