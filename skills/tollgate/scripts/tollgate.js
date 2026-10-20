#!/usr/bin/env node
// tollgate: a review ledger and loop governor for agent PRs.
//
// A reviewer finds things, the author fixes some, the reviewer finds more. How many rounds is that, how
// much of what came late was already visible in round one, and what was raised twice? tollgate reads a PR's
// review comments and answers, with evidence.
//
//   tollgate pr <number|url> [--repo owner/name] [--dir <clone>] [--cap 3] [--json]
//   tollgate scan --repo owner/name [--days 180] [--since <iso>] [--dir <clone>] [--wait] [--no-fetch] [--json]
//
//   tollgate add --file f --line n --text "..." [--code "<the line>"] [--nit|--blocking] [--reason "..."]
//   tollgate resolve <id> --fixed <sha> | --waive "<reason>"
//   tollgate round | status | gate [--cap 3] [--json]          live loop ledger, .tollgate/ledger.jsonl
//   tollgate gate --github --pr <n> [--repo o/r] [--fail-on block|escalate|never]   from review threads (token needed)
//
// Method (full text in references/method.md):
//   round     a distinct original_commit_id among a PR's inline review comments, in order of first comment.
//             Not commit_id: GitHub moves commit_id to the current head while a comment still applies.
//   finding   a top-level inline comment on a line (not a reply, not a file-level comment)
//   re-flag   a later finding on the same path with the same line text, or at least half the same words
//   visible   a round 2+ finding on a line that is unchanged between round 1's commit and its own commit
//
// Zero dependencies. Node 18+. GITHUB_TOKEN (or GH_TOKEN) raises the API limit from 60 to 5000 requests an hour.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- helpers ----------
const run = (args, cwd, input) => spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const git = (args, cwd) => { const r = run(args, cwd); return r.status === 0 ? r.stdout.trim() : ''; };
const gitOk = (args, cwd) => run(args, cwd).status === 0;
export function repoRoot(dir = process.cwd()) { return git(['rev-parse', '--show-toplevel'], dir) || resolve(dir); }
export function githubRepo(root, override) {
  if (override) return override;
  const m = git(['remote', 'get-url', 'origin'], root).match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
// Through a symlink or junction (~/.claude/skills/<name>) import.meta.url is the resolved target while argv[1] is
// the link, and a plain string compare says "not main".
const samePath = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
const short = (s, n = 110) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : /(s|sh|ch|x)$/.test(w) ? 'es' : 's'}`;
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : 0);
const uniq = (a) => [...new Set(a)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ISO = (d) => new Date(d).toISOString();

// ---------- text → tokens (same as grudge) ----------
const STOP = new Set(('a an the and or but if then else of to in on at for from by with without as is are was were be been being it its this that these those there here ' +
  'i you we they he she me my your our their them us his her him do does did done doing have has had having can could should would will shall may might must ' +
  'not no yes also just so than too very more most much many some any all each every both few other same such only own into over under again further once ' +
  'about above below between through during before after up down out off why how what which who whom when where because while until since though although ' +
  'get got gets make makes made let lets like want need think know see look use using used one two first last new old still well okay ok thanks thank please ' +
  'nit nitpick suggestion suggest maybe probably perhaps actually really sure fine good great nice lgtm wdyt imo imho btw fyi hmm yeah yep nope ' +
  'code line lines file files change changes changed pr commit function method value case thing things way version ' +
  'doesn isn don won wouldn shouldn couldn didn aren wasn weren hasn haven ain img src alt width height http https www com href div span').split(/\s+/));
export function tokens(text) {
  const t = String(text).toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->|<[^>\n]{1,200}>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@"[^"]*"|[a-z]:\\[^\s"']*|(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]*/g, ' ')
    .replace(/@[\w-]+/g, ' ')
    .replace(/`([^`]*)`/g, ' $1 ')
    .replace(/[^a-z0-9_\-./]+/g, ' ');
  const out = [];
  for (let w of t.split(/\s+/)) {
    w = w.replace(/^[-./]+|[-./]+$/g, '');
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || /[/\\:]/.test(w)) continue;
    if (w.length > 5 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('es') && !/[sxz]es$|[iu]es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is|os)$/.test(w)) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

// ---------- GitHub API ----------
export async function gh(path, { token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN, api = process.env.GITHUB_API_URL || 'https://api.github.com' } = {}) {
  const headers = { 'User-Agent': 'tollgate', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(api + path, { headers });
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
    const e = new Error(`GitHub rate limit hit${reset ? `, resets ${new Date(reset * 1000).toLocaleTimeString()}` : ''}. Set GITHUB_TOKEN for 5000 requests an hour.`);
    e.rateLimit = true; e.reset = reset; throw e;
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return { data: await res.json(), link: res.headers.get('link') || '' };
}
function cachePath(root, name) { const dir = join(root, '.tollgate', 'cache'); mkdirSync(dir, { recursive: true }); return join(dir, name); }
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

// A raw GitHub review comment, reduced to what the analysis needs.
const AI_BODY = /^\s*(<!--|\*\*\[AI[:\]]|\[AI[:\]]|### (Bug|Security|Issue|Suggestion):)/;
export function normalize(c) {
  const login = c.user?.login || '';
  const hunk = String(c.diff_hunk || '').split('\n').filter(Boolean);
  const last = hunk.length ? hunk[hunk.length - 1] : '';
  return {
    id: c.id, pr: Number(String(c.pull_request_url || '').split('/').pop()) || null, review: c.pull_request_review_id ?? null,
    path: c.path || '', body: c.body || '', user: login,
    bot: c.user?.type === 'Bot' || /\[bot\]$/.test(login) || AI_BODY.test(c.body || ''),
    reply: !!c.in_reply_to_id, created_at: c.created_at, url: c.html_url,
    commit: c.original_commit_id || null, head: c.commit_id || null,
    line: c.original_line ?? null, side: c.side || 'RIGHT', subject: c.subject_type || (c.original_line ? 'line' : 'file'),
    text: last.replace(/^[+\- ]/, '').trim(),
  };
}

// Newest comments last, so a crawl can resume: sort=created&direction=asc, page by page, saved after each page.
export async function crawlComments(root, repo, { since, cache = true, api, wait = false, pad = 5000, noFetch = false, log = () => {} } = {}) {
  const file = cache ? cachePath(root, `comments-${repo.replace('/', '__')}.json`) : null;
  let st = cache ? readJson(file) : null;
  if (!st || st.since !== since) st = { repo, since, items: {}, nextPage: 1, done: false, fetched_at: null };
  if (noFetch) { const c = cache ? readJson(file) : null; if (c) return { items: Object.values(c.items), done: c.done, partial: c.done ? null : 'cache only, crawl incomplete', fetchedAt: c.fetched_at, since: c.since }; return { items: [], done: false, partial: 'no cache', fetchedAt: null, since }; }
  if (st.done && Date.now() - Date.parse(st.fetched_at || 0) > 3600e3) st.done = false; // re-read the last page for new comments
  const save = () => { if (cache) writeFileSync(file, JSON.stringify(st)); };
  let partial = null;
  while (!st.done) {
    let data;
    try { ({ data } = await gh(`/repos/${repo}/pulls/comments?per_page=100&sort=created&direction=asc&since=${encodeURIComponent(since)}&page=${st.nextPage}`, { api })); }
    catch (e) {
      if (e.rateLimit && wait) { const ms = Math.max(0, e.reset * 1000 - Date.now() + pad); log(`rate limit; waiting ${Math.ceil(ms / 60000)} min (page ${st.nextPage})`); save(); await sleep(ms); continue; }
      if (!cache && !Object.keys(st.items).length) throw e;
      partial = e.message; break;
    }
    for (const c of data) st.items[c.id] = normalize(c);
    log(`page ${st.nextPage}: ${data.length} comments, ${Object.keys(st.items).length} total`);
    if (data.length < 100) { st.done = true; st.fetched_at = new Date().toISOString(); } else st.nextPage++;
    save();
  }
  save();
  return { items: Object.values(st.items), done: st.done, partial, fetchedAt: st.fetched_at, since: st.since };
}

export async function fetchPrComments(repo, pr, { api } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const { data } = await gh(`/repos/${repo}/pulls/${pr}/comments?per_page=100&page=${page}`, { api });
    out.push(...data.map(normalize));
    if (data.length < 100) break;
  }
  return out;
}

// ---------- rounds, findings, re-flags ----------
export const isFinding = (c) => !c.reply && c.subject !== 'file' && !!c.path && !!c.created_at;
const mode = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]; };

// Group comments by review, give each review the commit its reviewer saw, collapse reviews on the same commit.
export function buildRounds(findings) {
  const reviews = new Map();
  for (const f of findings) { const k = f.review ?? `c${f.id}`; if (!reviews.has(k)) reviews.set(k, []); reviews.get(k).push(f); }
  const byCommit = new Map();
  for (const [k, fs] of reviews) {
    const commit = mode(fs.map(f => f.commit).filter(Boolean)) || `review:${k}`;
    const first = fs.map(f => f.created_at).sort()[0];
    if (!byCommit.has(commit)) byCommit.set(commit, { commit, first, reviews: [], findings: [], unknownCommit: !fs.some(f => f.commit) });
    const r = byCommit.get(commit);
    r.reviews.push(k); r.findings.push(...fs); if (first < r.first) r.first = first;
  }
  const rounds = [...byCommit.values()].sort((a, b) => a.first.localeCompare(b.first)).map((r, i) => ({ n: i + 1, ...r }));
  for (const r of rounds) for (const f of r.findings) f.round = r.n;
  return rounds;
}

const normLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// A later finding is a re-flag of an earlier one on the same path when it points at the same line text
// (long enough not to be "}") or shares at least half of the smaller word set (and at least three words).
export function findReflags(rounds) {
  const all = rounds.flatMap(r => r.findings);
  for (const f of all) f._tok = new Set(tokens(f.body));
  const pairs = [];
  for (const f of all) {
    if (f.round < 2) continue;
    for (const e of all) {
      if (e.round >= f.round || e.path !== f.path) continue;
      const sameLine = normLine(f.text).length >= 15 && normLine(f.text) === normLine(e.text);
      let shared = 0; for (const w of f._tok) if (e._tok.has(w)) shared++;
      const sameWords = shared >= 3 && shared >= 0.5 * Math.min(f._tok.size, e._tok.size);
      if (sameLine || sameWords) { pairs.push({ from: e, to: f, why: sameLine ? 'same line' : 'same words' }); f.reflag = true; break; }
    }
  }
  for (const f of all) delete f._tok;
  return pairs;
}

// ---------- anchoring: was the line already there, unchanged, in round one? ----------
export function parseHunks(diff) {
  const ranges = [];
  for (const m of String(diff).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) { const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]); if (n > 0) ranges.push([start, start + n]); }
  return ranges;
}
const hasCommit = (dir, sha) => gitOk(['cat-file', '-e', `${sha}^{commit}`], dir);
// ls-tree reads trees only; `cat-file -e sha:path` would fetch the blob in a blobless clone
const hasPath = (dir, sha, path) => run(['ls-tree', '--name-only', sha, '--', path], dir).stdout.trim() === path;

// Fetch refs/pull/N/head for the given PR numbers into refs/tollgate/pr/N. One bad ref aborts a batch, so bisect.
export function fetchPrHeads(dir, prs, { shallowSince = null } = {}) {
  // refs fetched on an earlier run are kept: a rerun (or a frozen --no-fetch scan) does no network work for them
  const nums = uniq(prs).filter(Boolean).filter(n => !gitOk(['rev-parse', '--verify', '--quiet', `refs/tollgate/pr/${n}`], dir));
  const attempt = (list) => {
    if (!list.length) return;
    const specs = list.map(n => `+refs/pull/${n}/head:refs/tollgate/pr/${n}`);
    if (run(['fetch', '--no-tags', '--quiet', ...(shallowSince ? [`--shallow-since=${shallowSince}`] : []), 'origin', ...specs], dir).status === 0) return;
    if (list.length === 1) return;
    const mid = Math.ceil(list.length / 2); attempt(list.slice(0, mid)); attempt(list.slice(mid));
  };
  for (let i = 0; i < nums.length; i += 40) attempt(nums.slice(i, i + 40));
}

// Sets f.anchor to 'visible' | 'new' | 'unknown' (+ f.anchorWhy). Only rounds 2+ are anchored, against round 1's commit.
export function anchorRounds(dir, rounds, memo = new Map()) {
  if (rounds.length < 2) return;
  const c1 = rounds[0].commit;
  for (const r of rounds.slice(1)) for (const f of r.findings) {
    if (f.side === 'LEFT' || !f.line || !f.commit || /^review:/.test(c1)) { f.anchor = 'unknown'; f.anchorWhy = 'no usable line or commit'; continue; }
    if (!hasCommit(dir, c1) || !hasCommit(dir, f.commit)) { f.anchor = 'unknown'; f.anchorWhy = 'commit missing locally (force-pushed or not fetched)'; continue; }
    if (!hasPath(dir, c1, f.path)) { f.anchor = 'new'; f.anchorWhy = 'file did not exist in round 1'; continue; }
    const key = `${c1}|${f.commit}|${f.path}`;
    if (!memo.has(key)) memo.set(key, parseHunks(run(['diff', '-U0', '--no-renames', '--no-color', c1, f.commit, '--', f.path], dir).stdout));
    const changed = memo.get(key).some(([a, b]) => f.line >= a && f.line < b);
    f.anchor = changed ? 'new' : 'visible'; f.anchorWhy = changed ? 'line changed after round 1' : 'line unchanged since round 1';
  }
}

// ---------- analysis of one PR ----------
export function verdict(rounds, reflagCount, cap = 3) {
  if (rounds.length > cap) return 'OVER CAP';
  const late = rounds.slice(1).flatMap(r => r.findings).length;
  if (rounds.length >= 3 && (late >= rounds[0].findings.length || reflagCount >= 0.25 * late)) return 'LOOPING';
  return 'CONVERGING';
}

export function analyzePr(comments, { cap = 3, view = 'all', dir = null, memo } = {}) {
  // copies: each view marks its own re-flags and anchors; sharing the objects leaked one view's marks into the next
  let fs = comments.filter(isFinding).map(f => ({ ...f }));
  if (view === 'human') fs = fs.filter(f => !f.bot); else if (view === 'bot') fs = fs.filter(f => f.bot);
  fs = fs.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  const rounds = buildRounds(fs);
  const reflags = findReflags(rounds);
  if (dir) anchorRounds(dir, rounds, memo);
  const late = rounds.slice(1).flatMap(r => r.findings);
  const count = (k) => late.filter(f => f.anchor === k).length;
  return {
    pr: comments[0]?.pr ?? null, view, cap, findings: fs.length, rounds,
    late: late.length, reflags, reflagged: late.filter(f => f.reflag).length,
    visible: count('visible'), isNew: count('new'), unknown: late.length - count('visible') - count('new'),
    bots: fs.filter(f => f.bot).length, humans: fs.filter(f => !f.bot).length,
    verdict: verdict(rounds, late.filter(f => f.reflag).length, cap),
  };
}

// ---------- scan: many PRs ----------
const BOUNDARY_DAYS = 14;
export function aggregate(prResults, cap = 3) {
  const a = { prs: prResults.length, rounds: { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 }, max: 0, findings: 0, late: 0, reflagged: 0, visible: 0, isNew: 0, unknown: 0, overCap: 0, afterCap: 0, afterCapVisible: 0, afterCapNew: 0, afterCapUnknown: 0, bots: 0, humans: 0 };
  for (const p of prResults) {
    const n = p.rounds.length;
    a.rounds[n >= 5 ? '5+' : n]++; a.max = Math.max(a.max, n);
    a.findings += p.findings; a.late += p.late; a.reflagged += p.reflagged; a.visible += p.visible; a.isNew += p.isNew; a.unknown += p.unknown; a.bots += p.bots; a.humans += p.humans;
    if (n > cap) {
      a.overCap++;
      const after = p.rounds.slice(cap).flatMap(r => r.findings);
      a.afterCap += after.length;
      a.afterCapVisible += after.filter(f => f.anchor === 'visible').length;
      a.afterCapNew += after.filter(f => f.anchor === 'new').length;
      a.afterCapUnknown += after.filter(f => f.anchor !== 'visible' && f.anchor !== 'new').length;
    }
  }
  const known = a.visible + a.isNew;
  return { ...a, pct3: pct(a.rounds[3] + a.rounds[4] + a.rounds['5+'], a.prs), pct5: pct(a.rounds['5+'], a.prs), visiblePct: pct(a.visible, known), reflagPct: pct(a.reflagged, a.late), afterCapVisiblePct: pct(a.afterCapVisible, a.afterCapVisible + a.afterCapNew) };
}

// Pre-registered in the plan: pooled over repos with at least 100 PRs carrying inline review comments.
export function goNoGo(pooled) {
  const a = pooled.pct3 >= 10;
  const b = pooled.visiblePct >= 25 || pooled.reflagPct >= 10;
  return { go: a && b, a, b, thresholds: 'at least 10% of PRs reach 3+ rounds AND (at least 25% of round 2+ findings are visible in round one OR at least 10% are re-flags)' };
}

export async function scanRepo({ repo, days = 180, since: sinceOverride = null, dir = null, root = dir || process.cwd(), cap = 3, cache = true, api, wait = false, noFetch = false, log = () => {} } = {}) {
  const wanted = sinceOverride || ISO(Math.floor((Date.now() - days * 86400e3) / 86400e3) * 86400e3);
  const crawl = await crawlComments(root, repo, { since: wanted, cache, api, wait, noFetch, log });
  const since = crawl.since || wanted;
  const guard = ISO(Date.parse(since) + BOUNDARY_DAYS * 86400e3);
  const byPr = new Map();
  for (const c of crawl.items) if (c.pr) { if (!byPr.has(c.pr)) byPr.set(c.pr, []); byPr.get(c.pr).push(c); }
  // PRs whose first comment sits in the first two weeks of the window may have lost earlier rounds to the `since` filter.
  const prs = [...byPr.entries()].filter(([, cs]) => cs.map(c => c.created_at).sort()[0] >= guard).map(([n, cs]) => [n, cs]);
  if (dir && prs.length) {
    const multi = prs.filter(([, cs]) => buildRounds(cs.filter(isFinding).sort((a, b) => a.created_at.localeCompare(b.created_at))).length >= 2).map(([n]) => n);
    const shallow = git(['rev-parse', '--is-shallow-repository'], dir) === 'true';
    log(`PR heads: ${multi.length} multi-round PRs`); fetchPrHeads(dir, multi, { shallowSince: shallow ? ISO(Date.parse(since) - 30 * 86400e3).slice(0, 10) : null });
  }
  const memo = new Map(), views = {};
  for (const view of ['all', 'human', 'bot']) {
    const results = prs.map(([, cs]) => analyzePr(cs, { cap, view, dir, memo })).filter(p => p.findings > 0);
    views[view] = { ...aggregate(results, cap), results: view === 'all' ? results : undefined };
  }
  return { repo, at: new Date().toISOString(), days, since, guard, cap, anchored: !!dir, comments: crawl.items.length, complete: crawl.done, partial: crawl.partial, prsWithComments: byPr.size, prsInWindow: prs.length, views };
}

// ---------- output ----------
export function formatPr(r) {
  const L = [];
  L.push(`tollgate  PR #${r.pr}  ·  ${plural(r.findings, 'finding')}  ·  ${plural(r.rounds.length, 'round')} (cap ${r.cap})  ·  ${r.bots} bot, ${r.humans} human`);
  L.push(`${r.verdict}`);
  for (const rd of r.rounds) {
    const who = uniq(rd.findings.map(f => f.user)).slice(0, 3).join(', ');
    L.push(`  round ${rd.n}  ${rd.commit.slice(0, 7)}  ${String(rd.findings.length).padStart(3)} findings  ${who}`);
  }
  if (r.rounds.length > 1) {
    L.push(`late findings (round 2+): ${r.late}`);
    L.push(`  visible in round one: ${r.visible}  new code: ${r.isNew}  unknown: ${r.unknown}${r.unknown && !r.visible && !r.isNew ? '  (run inside a clone of the repo to anchor them)' : ''}`);
    L.push(`  re-flagged: ${r.reflagged}`);
    for (const p of r.reflags.slice(0, 4)) L.push(`    round ${p.to.round} repeats round ${p.from.round} (${p.why}, ${p.to.path}): "${short(p.to.body, 90)}"`);
    for (const f of r.rounds.slice(1).flatMap(x => x.findings).filter(f => f.anchor === 'visible').slice(0, 4)) L.push(`    visible: round ${f.round} ${f.path}:${f.line} "${short(f.body, 80)}"  ${f.url}`);
  }
  return L.join('\n');
}
export function formatScan(r) {
  const L = [`tollgate scan  ${r.repo}  ·  last ${r.days} days  ·  ${r.comments} comments  ·  ${r.prsInWindow} PRs in window${r.complete ? '' : '  (INCOMPLETE: ' + (r.partial || 'crawl not finished') + ')'}`];
  for (const [name, v] of Object.entries(r.views)) {
    if (!v.prs) { L.push(`  ${name.padEnd(5)} no PRs`); continue; }
    L.push(`  ${name.padEnd(5)} ${String(v.prs).padStart(4)} PRs  rounds 1/2/3/4/5+: ${[1, 2, 3, 4, '5+'].map(k => v.rounds[k]).join('/')}  3+: ${v.pct3}%  5+: ${v.pct5}%  max ${v.max}  late ${v.late}  visible ${v.visiblePct}% (n=${v.visible + v.isNew}, unknown ${v.unknown})  re-flag ${v.reflagPct}%`);
  }
  return L.join('\n');
}


// ---------- GraphQL: review-thread resolution (REST does not expose it) ----------
export async function ghql(query, variables, { token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN, api = process.env.GITHUB_API_URL || 'https://api.github.com' } = {}) {
  if (!token) throw new Error('GraphQL needs a token to read review threads: set GITHUB_TOKEN (the Action passes github.token)');
  const url = process.env.GITHUB_GRAPHQL_URL && api === (process.env.GITHUB_API_URL || 'https://api.github.com') ? process.env.GITHUB_GRAPHQL_URL : api.replace(/\/v3\/?$/, '') + '/graphql';
  const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'tollgate', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error('GitHub GraphQL ' + res.status);
  const j = await res.json();
  if (j.errors) throw new Error('GitHub GraphQL: ' + j.errors.map(e => e.message).join('; '));
  return j.data;
}
const THREADS_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated path line comments(first:1){nodes{body url author{login}}}}}}}}';
const NIT = /^\s*(\*\*)?\[?(nit|nitpick|optional|minor)\b/i;
export async function fetchThreads(repo, pr, { api, token } = {}) {
  const [owner, name] = repo.split('/'); const out = []; let after = null;
  for (;;) {
    const d = await ghql(THREADS_QUERY, { owner, name, number: pr, after }, { api, token });
    const t = d.repository?.pullRequest?.reviewThreads; if (!t) throw new Error('pull request ' + repo + '#' + pr + ' not found');
    for (const n of t.nodes) { const c = n.comments?.nodes?.[0] || {}; out.push({ resolved: !!n.isResolved, outdated: !!n.isOutdated, path: n.path, line: n.line, body: c.body || '', url: c.url, by: c.author?.login || '', nit: NIT.test(c.body || '') }); }
    if (!t.pageInfo.hasNextPage) break; after = t.pageInfo.endCursor;
  }
  return out;
}

// The verdict, one definition for the local ledger and for GitHub threads.
// ESCALATE: over the round cap with blocking findings still open (a human decides; forcing more rounds is the loop).
export function decide({ round, cap, blocking }) {
  if (blocking > 0 && round > cap) return 'ESCALATE';
  if (blocking > 0) return 'BLOCK';
  return 'PASS';
}
export const EXIT = { PASS: 0, BLOCK: 1, ESCALATE: 3 };

export async function gateGithub({ repo, pr, cap = 3, dir = null, api, token } = {}) {
  const comments = await fetchPrComments(repo, pr, { api });
  const threads = await fetchThreads(repo, pr, { api, token });
  if (dir) fetchPrHeads(dir, [pr]);
  const a = analyzePr(comments, { cap, dir });
  const unresolved = threads.filter(t => !t.resolved);
  const blocking = unresolved.filter(t => !t.nit).length;
  const rounds = Math.max(a.rounds.length, 1);
  return { pr, repo, cap, rounds, threads: threads.length, open: unresolved.length, blocking, nits: unresolved.length - blocking, reflags: a.reflagged, late: a.late, visible: a.visible, isNew: a.isNew, verdict: decide({ round: rounds, cap, blocking }), unresolved };
}

// ---------- live-loop ledger (.tollgate/ledger.jsonl, append-only) ----------
export const ledgerFile = (root) => join(root, '.tollgate', 'ledger.jsonl');
export function currentBranch(root) { return git(['branch', '--show-current'], root) || 'HEAD'; }
export function readConfig(root) { const c = readJson(join(root, '.tollgate.json')) || {}; return { cap: Number.isInteger(c.cap) && c.cap > 0 ? c.cap : 3 }; }
function appendEvent(root, ev) { const f = ledgerFile(root); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n'); }
export function hasLedger(root, branch) {
  try { return readFileSync(ledgerFile(root), 'utf8').split('\n').some(l => { try { return JSON.parse(l).branch === branch; } catch { return false; } }); } catch { return false; }
}
export function loadLedger(root, branch) {
  const st = { branch, round: 1, findings: new Map(), adds: 0, repeats: 0 };
  let raw = ''; try { raw = readFileSync(ledgerFile(root), 'utf8'); } catch { return st; }
  for (const line of raw.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.branch !== branch) continue;
    if (e.type === 'round') st.round++;
    else if (e.type === 'add') { st.adds++; st.findings.set(e.id, { id: e.id, file: e.file, line: e.line ?? null, text: e.text, code: e.code || '', severity: e.severity || 'blocking', round: e.round, status: 'open', reflagOf: e.reflagOf || null, reopens: e.reopens || null, reason: e.reason || null, fixSha: e.reopens ? (st.findings.get(e.reopens)?.fixSha || null) : null, waiver: null, repeats: 0 }); }
    else if (e.type === 'repeat') { const f = st.findings.get(e.of); if (f) { f.repeats++; st.repeats++; } }
    else if (e.type === 'fixed') { const f = st.findings.get(e.id); if (f) { f.status = 'fixed'; f.fixSha = e.sha; } }
    else if (e.type === 'waived') { const f = st.findings.get(e.id); if (f) { f.status = 'waived'; f.waiver = e.reason; } }
  }
  return st;
}
const matches = (a, b) => {
  if (a.file !== b.file) return false;
  const la = normLine(a.code), lb = normLine(b.code);
  if (la.length >= 15 && la === lb) return true;
  const A = new Set(tokens(a.text)), B = new Set(tokens(b.text)); let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared >= 3 && shared >= 0.5 * Math.min(A.size, B.size);
};
// Re-flags are always recorded. A repeat of an open finding bumps its counter; a repeat of a fixed one reopens it
// ("fix incomplete", the original fix sha is kept); a repeat of a waived one needs a stated reason.
export function addFinding(root, branch, { file, line = null, text, code = '', severity = 'blocking', reason = null }) {
  if (!file || !text) throw new Error('add needs --file and --text');
  const st = loadLedger(root, branch);
  const earlier = [...st.findings.values()].reverse().find(f => matches(f, { file, text, code }));
  const id = 't-' + (st.adds + 1);
  if (earlier && earlier.status === 'open') { appendEvent(root, { branch, type: 'repeat', of: earlier.id, round: st.round, text }); return { kind: 'repeat', id: earlier.id, of: earlier.id, round: earlier.round, now: st.round }; }
  if (earlier && earlier.status === 'waived' && !reason) return { kind: 'needs-reason', id: null, of: earlier.id, waiver: earlier.waiver };
  appendEvent(root, { branch, type: 'add', id, file, line, text, code, severity, round: st.round, reflagOf: earlier ? earlier.id : null, reopens: earlier && earlier.status === 'fixed' ? earlier.id : null, reason: earlier && earlier.status === 'waived' ? reason : null });
  return { kind: !earlier ? 'new' : earlier.status === 'fixed' ? 'reopened' : 'reflag-waived', id, of: earlier ? earlier.id : null, fixSha: earlier && earlier.status === 'fixed' ? earlier.fixSha : null, waiver: earlier && earlier.status === 'waived' ? earlier.waiver : null, round: st.round };
}
export function resolveFinding(root, branch, id, { fixed = null, waive = null }) {
  const st = loadLedger(root, branch); const f = st.findings.get(id);
  if (!f) throw new Error('no finding ' + id + ' on branch ' + branch);
  if (f.status !== 'open') throw new Error(id + ' is already ' + f.status);
  if (fixed) { appendEvent(root, { branch, type: 'fixed', id, sha: fixed }); return { id, status: 'fixed', sha: fixed }; }
  if (waive && waive.trim().length >= 5) { appendEvent(root, { branch, type: 'waived', id, reason: waive.trim() }); return { id, status: 'waived', reason: waive.trim() }; }
  throw new Error('resolve needs --fixed <sha> or --waive "<reason of at least 5 characters>"');
}
export function nextRound(root, branch) { appendEvent(root, { branch, type: 'round' }); return loadLedger(root, branch).round; }
export function gateLocal(root, branch, cap = readConfig(root).cap) {
  const st = loadLedger(root, branch); const all = [...st.findings.values()];
  const open = all.filter(f => f.status === 'open'), blocking = open.filter(f => f.severity !== 'nit');
  const reopened = all.filter(f => f.reopens).length;
  return { branch, round: st.round, cap, open: open.length, blocking: blocking.length, nits: open.length - blocking.length, fixed: all.filter(f => f.status === 'fixed').length, waived: all.filter(f => f.status === 'waived').length, reopened, repeats: st.repeats, verdict: decide({ round: st.round, cap, blocking: blocking.length }), openFindings: open };
}
export function formatStatus(g) {
  const L = [`tollgate  ${g.branch}  ·  round ${g.round} of cap ${g.cap}  ·  ${g.verdict}  ·  open ${g.open} (${g.blocking} blocking)  ·  fixed ${g.fixed}  ·  waived ${g.waived}  ·  reopened ${g.reopened}  ·  repeats ${g.repeats}`];
  for (const f of g.openFindings.slice(0, 12)) L.push(`  ${f.id}  ${f.severity.padEnd(8)} ${f.file}${f.line ? ':' + f.line : ''}  "${short(f.text, 90)}"  (round ${f.round}${f.reopens ? ', REOPENED: fix incomplete, was fixed in ' + String(f.fixSha || '?').slice(0, 7) : ''})`);
  if (g.openFindings.length > 12) L.push(`  … ${g.openFindings.length - 12} more`);
  return L.join('\n');
}
export function formatGate(g) {
  const L = [`tollgate gate  PR ${g.repo}#${g.pr}  ·  ${g.verdict}  ·  round ${g.rounds} of cap ${g.cap}  ·  ${g.open} unresolved threads (${g.blocking} blocking, ${g.nits} nit)  ·  ${g.reflags} re-flagged`];
  for (const t of g.unresolved.filter(t => !t.nit).slice(0, 10)) L.push(`  ${t.path}${t.line ? ':' + t.line : ''}  ${t.by}  "${short(t.body, 90)}"  ${t.url || ''}`);
  if (g.verdict === 'ESCALATE') L.push(`Round ${g.rounds} is over the cap of ${g.cap} with ${g.blocking} blocking threads still open: a human decides. Another automated round is the loop tollgate exists to stop.`);
  return L.join('\n');
}
export function gateMarkdown(g) {
  const L = [`### tollgate: ${g.verdict}`, '', `PR #${g.pr} is in round **${g.rounds}** (cap ${g.cap}). ${g.open} unresolved review threads: **${g.blocking} blocking**, ${g.nits} nit. ${g.reflags} later finding(s) repeat an earlier one; ${g.visible} of ${g.visible + g.isNew} late findings were already visible in round one.`];
  if (g.blocking) { L.push('', '| thread | by | finding |', '|---|---|---|'); for (const t of g.unresolved.filter(t => !t.nit).slice(0, 15)) L.push(`| ${t.path}${t.line ? ':' + t.line : ''} | ${t.by} | ${short(t.body, 100).replace(/\|/g, '\\|')} |`); }
  if (g.verdict === 'ESCALATE') L.push('', 'Over the round cap with blocking findings open. A human decides whether to keep going.');
  return L.join('\n');
}

// ---------- cli ----------
function parseTarget(t) {
  const m = String(t || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (m) return { repo: m[1], pr: Number(m[2]) };
  if (/^\d+$/.test(String(t))) return { repo: null, pr: Number(t) };
  return null;
}
async function main(a) {
  const has = k => a.includes(k);
  const flag = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const sub = a[0];
  const json = has('--json');
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return;
  }
  const cap = Number(flag('--cap', 3));
  const dirFlag = flag('--dir');
  const root = repoRoot(dirFlag || process.cwd());
  const isClone = !!dirFlag || existsSync(join(root, '.git'));
  if (sub === 'pr') {
    const t = parseTarget(a[1]);
    if (!t) { console.error('tollgate pr: give a PR number or URL'); process.exit(2); }
    const repo = t.repo || githubRepo(root, flag('--repo'));
    if (!repo) { console.error('tollgate pr: no GitHub remote here; pass --repo owner/name or a PR URL'); process.exit(2); }
    const comments = await fetchPrComments(repo, t.pr, { api: flag('--api') });
    const dir = isClone && gitOk(['rev-parse', '--git-dir'], root) ? root : null;
    if (dir) fetchPrHeads(dir, [t.pr]);
    const r = analyzePr(comments, { cap, dir });
    console.log(json ? JSON.stringify(r, (k, v) => (k === 'from' || k === 'to' ? { id: v.id, round: v.round, path: v.path } : v), 2) : formatPr(r));
    return;
  }
  if (sub === 'scan') {
    const repo = githubRepo(root, flag('--repo'));
    if (!repo) { console.error('tollgate scan: pass --repo owner/name'); process.exit(2); }
    const dir = dirFlag && gitOk(['rev-parse', '--git-dir'], dirFlag) ? dirFlag : null;
    const r = await scanRepo({ repo, days: Number(flag('--days', 180)), since: flag('--since'), dir, root, cap, api: flag('--api'), wait: has('--wait'), noFetch: has('--no-fetch'), cache: !has('--no-cache'), log: has('--quiet') ? () => {} : (m) => console.error(m) });
    console.log(json ? JSON.stringify(r, (k, v) => (k === 'results' ? undefined : v), 2) : formatScan(r));
    return;
  }
  if (sub === 'add' || sub === 'resolve' || sub === 'round' || sub === 'status' || (sub === 'gate' && !has('--github'))) {
    const branch = flag('--branch') || currentBranch(root);
    const cfgCap = has('--cap') ? cap : readConfig(root).cap;
    if (sub === 'add') {
      const r = addFinding(root, branch, { file: flag('--file'), line: flag('--line') ? Number(flag('--line')) : null, text: flag('--text'), code: flag('--code', ''), severity: has('--nit') ? 'nit' : 'blocking', reason: flag('--reason') });
      if (r.kind === 'needs-reason') { console.error('tollgate: ' + r.of + ' was waived ("' + r.waiver + '"). Raising it again needs --reason saying why the waiver no longer holds.'); process.exit(4); }
      const msg = { new: 'added ' + r.id + ' (round ' + r.round + ')', repeat: 'REPEAT of ' + r.of + ' (still open, raised in round ' + r.round + '; now round ' + r.now + ')', reopened: 'REOPENED ' + r.id + ': fix incomplete, ' + r.of + ' was fixed in ' + String(r.fixSha || '?').slice(0, 7), 'reflag-waived': 'added ' + r.id + ' (re-flag of waived ' + r.of + ': "' + r.waiver + '")' }[r.kind];
      console.log(json ? JSON.stringify(r) : msg); return;
    }
    if (sub === 'resolve') { const r = resolveFinding(root, branch, a[1], { fixed: flag('--fixed'), waive: flag('--waive') }); console.log(json ? JSON.stringify(r) : r.id + ' ' + r.status + (r.sha ? ' in ' + r.sha.slice(0, 7) : ': ' + r.reason)); return; }
    if (sub === 'round') { console.log('round ' + nextRound(root, branch)); return; }
    const g = gateLocal(root, branch, cfgCap);
    if (sub === 'status') { console.log(json ? JSON.stringify(g, null, 2) : formatStatus(g)); return; }
    console.log(json ? JSON.stringify(g, null, 2) : formatStatus(g)); process.exitCode = EXIT[g.verdict]; return;
  }
  if (sub === 'gate') {
    const t = parseTarget(flag('--pr') || process.env.TOLLGATE_PR);
    const repo = (t && t.repo) || flag('--repo') || process.env.GITHUB_REPOSITORY || githubRepo(root);
    if (!t || !repo) { console.error('tollgate gate --github: pass --pr <number> and --repo owner/name (or run it in an Action)'); process.exit(2); }
    // anchor against the local clone only when it is the repository being gated
    const dir = dirFlag || (isClone && githubRepo(root) === repo && gitOk(['rev-parse', '--git-dir'], root) ? root : null);
    const g = await gateGithub({ repo, pr: t.pr, cap, dir, api: flag('--api') });
    console.log(json ? JSON.stringify(g, null, 2) : formatGate(g));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, ['verdict=' + g.verdict, 'rounds=' + g.rounds, 'open=' + g.open, 'blocking=' + g.blocking, 'cap=' + g.cap, 'reflags=' + g.reflags].join('\n') + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, gateMarkdown(g) + '\n');
    const failOn = flag('--fail-on', 'never');
    if ((failOn === 'block' && g.verdict !== 'PASS') || (failOn === 'escalate' && g.verdict === 'ESCALATE')) process.exitCode = EXIT[g.verdict];
    return;
  }
  console.error('tollgate: unknown command "' + sub + '". Try: pr, scan, add, resolve, round, status, gate'); process.exit(2);
}
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(e => { console.error(`tollgate: ${e.message}`); process.exit(1); });
}
