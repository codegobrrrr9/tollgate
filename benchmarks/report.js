#!/usr/bin/env node
// Turns benchmarks/scan.jsonl (raw rows) into benchmarks/results.md. Deterministic: same rows, same file.
//   node benchmarks/report.js

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goNoGo } from '../skills/tollgate/scripts/tollgate.js';

const here = dirname(fileURLToPath(import.meta.url));
// the latest row per repo: scan.jsonl is an append-only log and a later row replaces an earlier one
const latest = new Map();
for (const r of readFileSync(join(here, 'scan.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)) latest.set(r.repo, r);
const rows = [...latest.values()];
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : 0);
const sum = (vs, k) => vs.reduce((n, v) => n + (v[k] || 0), 0);
const merge = (vs) => {
  const rounds = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 }; for (const v of vs) for (const k of Object.keys(rounds)) rounds[k] += v.rounds[k] || 0;
  const m = { prs: sum(vs, 'prs'), rounds, max: Math.max(...vs.map(v => v.max)), findings: sum(vs, 'findings'), late: sum(vs, 'late'), reflagged: sum(vs, 'reflagged'), visible: sum(vs, 'visible'), isNew: sum(vs, 'isNew'), unknown: sum(vs, 'unknown'), overCap: sum(vs, 'overCap'), afterCap: sum(vs, 'afterCap'), afterCapVisible: sum(vs, 'afterCapVisible'), afterCapNew: sum(vs, 'afterCapNew'), afterCapUnknown: sum(vs, 'afterCapUnknown'), bots: sum(vs, 'bots'), humans: sum(vs, 'humans') };
  m.pct3 = pct(m.rounds[3] + m.rounds[4] + m.rounds['5+'], m.prs); m.pct5 = pct(m.rounds['5+'], m.prs);
  m.visiblePct = pct(m.visible, m.visible + m.isNew); m.reflagPct = pct(m.reflagged, m.late);
  m.afterCapVisiblePct = pct(m.afterCapVisible, m.afterCapVisible + m.afterCapNew);
  return m;
};
const all = rows.map(r => ({ repo: r.repo, ...r.views.all, r }));
const pooled = merge(all);
const bot = merge(rows.map(r => r.views.bot)), human = merge(rows.map(r => r.views.human));
const d = goNoGo(pooled);
const L = [];
L.push('# tollgate benchmark results', '');
L.push(`Generated from \`benchmarks/scan.jsonl\` by \`benchmarks/report.js\`. Window: the ${rows[0].days} days from ${rows[0].since.slice(0, 10)} (PRs whose first comment is in the first 14 days are dropped, see method). Run ${rows[0].at.slice(0, 10)}. Public GitHub data and local git; no model runs. Definitions: [method.md](../skills/tollgate/references/method.md), fixed before the data was read.`, '');
L.push('## B1: how many rounds', '');
L.push('A round is a distinct commit a reviewer was looking at (`original_commit_id`). Counts are PRs that received at least one inline review comment.', '');
L.push('| Repo | PRs | 1 round | 2 | 3 | 4 | 5+ | 3+ rounds | 5+ rounds | Most rounds | Bot share of findings |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const v of all) L.push(`| ${v.repo} | ${v.prs} | ${v.rounds[1]} | ${v.rounds[2]} | ${v.rounds[3]} | ${v.rounds[4]} | ${v.rounds['5+']} | **${v.pct3}%** | ${v.pct5}% | ${v.max} | ${pct(v.bots, v.findings)}% |`);
L.push(`| **Pooled** | **${pooled.prs}** | ${pooled.rounds[1]} | ${pooled.rounds[2]} | ${pooled.rounds[3]} | ${pooled.rounds[4]} | ${pooled.rounds['5+']} | **${pooled.pct3}%** | ${pooled.pct5}% | ${pooled.max} | ${pct(pooled.bots, pooled.findings)}% |`, '');
L.push('## B2: was it already there in round one', '');
L.push('For findings in round 2 or later: was the commented line unchanged between round 1\'s commit and the finding\'s own commit (**visible**), or written or changed after round 1 (**new**)? Unknown findings (a deleted-side comment, a commit force-pushed away) are counted and left out of the percentage.', '');
L.push('| Repo | Late findings | Visible in round one | New code | Unknown | Visible share | Re-flagged |', '|---|---|---|---|---|---|---|');
for (const v of all) L.push(`| ${v.repo} | ${v.late} | ${v.visible} | ${v.isNew} | ${v.unknown} | **${v.visiblePct}%** | ${v.reflagged} (${v.reflagPct}%) |`);
L.push(`| **Pooled** | **${pooled.late}** | ${pooled.visible} | ${pooled.isNew} | ${pooled.unknown} | **${pooled.visiblePct}%** | ${pooled.reflagged} (${pooled.reflagPct}%) |`, '');
L.push('By reviewer kind, pooled over the five repos (rounds rebuilt from each kind\'s own findings):', '');
L.push('| View | PRs | 3+ rounds | Late findings | Visible share | Re-flag rate |', '|---|---|---|---|---|---|');
for (const [n, v] of [['all', pooled], ['human', human], ['bot', bot]]) L.push(`| ${n} | ${v.prs} | ${v.pct3}% | ${v.late} | ${v.visiblePct}% (n=${v.visible + v.isNew}) | ${v.reflagPct}% |`);
L.push('');
L.push('## B3: what a cap of 3 would have touched', '');
L.push('If rounds had been capped at 3, the findings in round 4 and later would not have been raised. Were they churn on old code, or findings about code the fixes had just changed?', '');
L.push('| Repo | PRs over the cap | Findings after round 3 | On code visible in round one | On code changed after round one | Unknown |', '|---|---|---|---|---|---|');
for (const v of all) L.push(`| ${v.repo} | ${v.overCap} | ${v.afterCap} | ${v.afterCapVisible} | ${v.afterCapNew} | ${v.afterCapUnknown} |`);
L.push(`| **Pooled** | **${pooled.overCap}** (${pct(pooled.overCap, pooled.prs)}% of PRs) | **${pooled.afterCap}** | ${pooled.afterCapVisible} (**${pooled.afterCapVisiblePct}%**) | ${pooled.afterCapNew} | ${pooled.afterCapUnknown} |`, '');
L.push('## Pre-registered decision', '');
L.push(`Rule: ${d.thresholds}.`, '', `Pooled result: ${pooled.pct3}% of PRs reach 3+ rounds; ${pooled.visiblePct}% of known late findings were visible in round one; ${pooled.reflagPct}% were re-flags. **${d.go ? 'GO' : 'NO-GO'}** (a: ${d.a}, b: ${d.b}).`, '');
L.push('## How to read this', '');
L.push(`- Most PRs get one round (${pct(pooled.rounds[1], pooled.prs)}%). The loop is the exception: ${pooled.pct3}% reach 3+ rounds, ${pooled.pct5}% reach 5+.`);
L.push(`- About ${Math.round(pooled.visiblePct)}% of what comes late was already on the page in round one. That is not the same as "the reviewer should have caught it": some of those are real misses, some are second thoughts, some are repeats.`);
L.push(`- The repos disagree widely: the visible share runs from ${Math.min(...all.map(v => v.visiblePct))}% to ${Math.max(...all.map(v => v.visiblePct))}%. All of zod's inline review comments in this window came from bots, and its late findings are mostly on new code, which is what a reviewer looking at each new push would produce.`);
L.push(`- **A cap that silences findings would mostly silence findings about new code.** After round 3, ${pooled.afterCapVisiblePct}% were on code visible in round one and ${pct(pooled.afterCapNew, pooled.afterCapVisible + pooled.afterCapNew)}% were on code the fixes had changed. That is why tollgate escalates to a human at the cap instead of dropping findings.`);
L.push(`- Humans and bots differ: ${human.visiblePct}% of human late findings were visible in round one against ${bot.visiblePct}% for bots, and ${bot.reflagPct}% of bot late findings repeat an earlier one against ${human.reflagPct}% for humans. A repeat is found by shared words on the same path, so it can merge two distinct findings; the tool shows each pair.`);
L.push('', '## Corrections', '');
L.push('- The first benchmark run analysed the all, human and bot views on shared finding objects, so a re-flag mark from one view could leak into the next. The headline all-view numbers and the go/no-go decision were unaffected (that view runs first, on clean objects). One count moved: sveltejs/kit bot re-flags, 8 to 7. The pooled after-cap split printed by the runner (149 visible, 265 new) was computed from the leaked objects; the per-repo rows summed here (140 and 274) are correct. A regression test now fails on the old behaviour, and the run was repeated frozen from the cache: every all-view count is identical to the first run.');
L.push('', '## Limits', '');
L.push('- Counts what review comments exist, not whether a finding was valid.');
L.push('- Five public repos chosen for review volume, not a sample of GitHub. Their bot reviewers are not Anthropic\'s pipeline, and nothing here measures Anthropic\'s figures.');
L.push('- PRs are counted whether or not they merged. Top-level PR comments and reviews without inline comments are not findings.');
L.push('- A file renamed between rounds is counted as new code, which can only lower the visible share.');
writeFileSync(join(here, 'results.md'), L.join('\n') + '\n');
console.log(L.slice(0, 40).join('\n'));
