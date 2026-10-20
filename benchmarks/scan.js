#!/usr/bin/env node
// Benchmark: how many review rounds do PRs on real, review-heavy repos take, how much of what comes late was
// already visible in round one, and what is raised twice? No model runs; public GitHub data plus local git.
//
//   node benchmarks/scan.js [--days 180] [--repos owner/a,owner/b] [--no-wait]
//
// Clones each repo blobless and shallow (benchmarks/work/<owner__repo>), crawls review comments with a resumable
// cache (60 requests an hour unauthenticated; set GITHUB_TOKEN yourself to go faster), anchors round 2+ findings
// against round 1 with git, appends one row per repo to benchmarks/scan.jsonl and writes work/scan.done when finished.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo, formatScan, aggregate, goNoGo } from '../skills/tollgate/scripts/tollgate.js';

const here = dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const flag = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const days = Number(flag('--days', 180));
const repos = (flag('--repos', 'withastro/astro,sveltejs/kit,TanStack/query,colinhacks/zod,vitest-dev/vitest')).split(',');
const work = join(here, 'work'); mkdirSync(work, { recursive: true });
const g = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const log = (m) => console.error(`[${new Date().toLocaleTimeString()}] ${m}`);

const results = [];
for (const repo of repos) {
  const dir = join(work, repo.replace('/', '__'));
  if (!existsSync(join(dir, '.git'))) {
    const since = new Date(Date.now() - (days + 45) * 86400e3).toISOString().slice(0, 10);
    log(`cloning ${repo} (blobless, shallow since ${since})`);
    const r = g(['clone', '--filter=blob:none', '--no-checkout', '--single-branch', `--shallow-since=${since}`, `https://github.com/${repo}.git`, dir]);
    if (r.status !== 0) { log(`clone failed for ${repo}: ${r.stderr.slice(0, 200)}`); continue; }
  }
  const t0 = Date.now();
  const r = await scanRepo({ repo, days, dir, root: dir, wait: !a.includes('--no-wait'), log });
  appendFileSync(join(here, 'scan.jsonl'), JSON.stringify({ ...r, views: Object.fromEntries(Object.entries(r.views).map(([k, v]) => [k, { ...v, results: undefined }])), seconds: Math.round((Date.now() - t0) / 1000) }) + '\n');
  results.push({ repo, r });
  console.log(formatScan(r));
}

// pooled over repos with at least 100 PRs carrying inline review comments (pre-registered)
const eligible = results.filter(x => x.r.views.all.prs >= 100);
const pooled = aggregate(eligible.flatMap(x => x.r.views.all.results || []));
const decision = goNoGo(pooled);
console.log(`\nPOOLED (${eligible.length} of ${results.length} repos with >= 100 PRs): ${pooled.prs} PRs, 3+ rounds ${pooled.pct3}%, 5+ rounds ${pooled.pct5}%, late findings ${pooled.late}, visible in round one ${pooled.visiblePct}% (n=${pooled.visible + pooled.isNew}, unknown ${pooled.unknown}), re-flag ${pooled.reflagPct}%`);
console.log(`GO / NO-GO: ${decision.go ? 'GO' : 'NO-GO'}  (a: ${decision.a}, b: ${decision.b})  ${decision.thresholds}`);
writeFileSync(join(work, 'scan.done'), JSON.stringify({ at: new Date().toISOString(), decision, pooled, repos: results.map(x => x.repo) }, null, 2));
