# tollgate benchmark results

Generated from `benchmarks/scan.jsonl` by `benchmarks/report.js`. Window: the 180 days from 2026-04-23 (PRs whose first comment is in the first 14 days are dropped, see method). Run 2026-10-20. Public GitHub data and local git; no model runs. Definitions: [method.md](../skills/tollgate/references/method.md), fixed before the data was read.

## B1: how many rounds

A round is a distinct commit a reviewer was looking at (`original_commit_id`). Counts are PRs that received at least one inline review comment.

| Repo | PRs | 1 round | 2 | 3 | 4 | 5+ | 3+ rounds | 5+ rounds | Most rounds | Bot share of findings |
|---|---|---|---|---|---|---|---|---|---|---|
| withastro/astro | 266 | 207 | 36 | 10 | 8 | 5 | **8.6%** | 1.9% | 9 | 16.8% |
| sveltejs/kit | 396 | 248 | 77 | 37 | 11 | 23 | **17.9%** | 5.8% | 14 | 28.6% |
| TanStack/query | 280 | 239 | 29 | 8 | 3 | 1 | **4.3%** | 0.4% | 5 | 86.6% |
| colinhacks/zod | 139 | 79 | 24 | 15 | 5 | 16 | **25.9%** | 11.5% | 10 | 100% |
| vitest-dev/vitest | 220 | 158 | 36 | 16 | 3 | 7 | **11.8%** | 3.2% | 11 | 14.6% |
| **Pooled** | **1301** | 931 | 202 | 86 | 30 | 52 | **12.9%** | 4% | 14 | 43.8% |

## B2: was it already there in round one

For findings in round 2 or later: was the commented line unchanged between round 1's commit and the finding's own commit (**visible**), or written or changed after round 1 (**new**)? Unknown findings (a deleted-side comment, a commit force-pushed away) are counted and left out of the percentage.

| Repo | Late findings | Visible in round one | New code | Unknown | Visible share | Re-flagged |
|---|---|---|---|---|---|---|
| withastro/astro | 211 | 113 | 94 | 4 | **54.6%** | 3 (1.4%) |
| sveltejs/kit | 575 | 311 | 248 | 16 | **55.6%** | 28 (4.9%) |
| TanStack/query | 106 | 63 | 43 | 0 | **59.4%** | 16 (15.1%) |
| colinhacks/zod | 248 | 34 | 214 | 0 | **13.7%** | 12 (4.8%) |
| vitest-dev/vitest | 203 | 90 | 110 | 3 | **45%** | 23 (11.3%) |
| **Pooled** | **1343** | 611 | 709 | 23 | **46.3%** | 82 (6.1%) |

By reviewer kind, pooled over the five repos (rounds rebuilt from each kind's own findings):

| View | PRs | 3+ rounds | Late findings | Visible share | Re-flag rate |
|---|---|---|---|---|---|
| all | 1301 | 12.9% | 1343 | 46.3% (n=1320) | 6.1% |
| human | 767 | 9.9% | 663 | 55% (n=644) | 3.3% |
| bot | 677 | 9.7% | 466 | 27.3% (n=465) | 10.9% |

## B3: what a cap of 3 would have touched

If rounds had been capped at 3, the findings in round 4 and later would not have been raised. Were they churn on old code, or findings about code the fixes had just changed?

| Repo | PRs over the cap | Findings after round 3 | On code visible in round one | On code changed after round one | Unknown |
|---|---|---|---|---|---|
| withastro/astro | 13 | 58 | 25 | 32 | 1 |
| sveltejs/kit | 34 | 192 | 85 | 104 | 3 |
| TanStack/query | 4 | 7 | 3 | 4 | 0 |
| colinhacks/zod | 21 | 100 | 9 | 91 | 0 |
| vitest-dev/vitest | 10 | 61 | 18 | 43 | 0 |
| **Pooled** | **82** (6.3% of PRs) | **418** | 140 (**33.8%**) | 274 | 4 |

## Pre-registered decision

Rule: at least 10% of PRs reach 3+ rounds AND (at least 25% of round 2+ findings are visible in round one OR at least 10% are re-flags).

Pooled result: 12.9% of PRs reach 3+ rounds; 46.3% of known late findings were visible in round one; 6.1% were re-flags. **GO** (a: true, b: true).

## How to read this

- Most PRs get one round (71.6%). The loop is the exception: 12.9% reach 3+ rounds, 4% reach 5+.
- About 46% of what comes late was already on the page in round one. That is not the same as "the reviewer should have caught it": some of those are real misses, some are second thoughts, some are repeats.
- The repos disagree widely: the visible share runs from 13.7% to 59.4%. All of zod's inline review comments in this window came from bots, and its late findings are mostly on new code, which is what a reviewer looking at each new push would produce.
- **A cap that silences findings would mostly silence findings about new code.** After round 3, 33.8% were on code visible in round one and 66.2% were on code the fixes had changed. That is why tollgate escalates to a human at the cap instead of dropping findings.
- Humans and bots differ: 55% of human late findings were visible in round one against 27.3% for bots, and 10.9% of bot late findings repeat an earlier one against 3.3% for humans. A repeat is found by shared words on the same path, so it can merge two distinct findings; the tool shows each pair.

## Corrections

- The first benchmark run analysed the all, human and bot views on shared finding objects, so a re-flag mark from one view could leak into the next. The headline all-view numbers and the go/no-go decision were unaffected (that view runs first, on clean objects). One count moved: sveltejs/kit bot re-flags, 8 to 7. The pooled after-cap split printed by the runner (149 visible, 265 new) was computed from the leaked objects; the per-repo rows summed here (140 and 274) are correct. A regression test now fails on the old behaviour, and the run was repeated frozen from the cache: every all-view count is identical to the first run.

## Limits

- Counts what review comments exist, not whether a finding was valid.
- Five public repos chosen for review volume, not a sample of GitHub. Their bot reviewers are not Anthropic's pipeline, and nothing here measures Anthropic's figures.
- PRs are counted whether or not they merged. Top-level PR comments and reviews without inline comments are not findings.
- A file renamed between rounds is counted as new code, which can only lower the visible share.
