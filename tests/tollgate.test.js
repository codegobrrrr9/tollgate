import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalize, isFinding, buildRounds, findReflags, parseHunks, fetchPrHeads, anchorRounds, analyzePr, verdict, aggregate, goNoGo, crawlComments, fetchPrComments, scanRepo, formatPr, formatScan, tokens } from '../skills/tollgate/scripts/tollgate.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'tollgate', 'scripts', 'tollgate.js');
const tmp = () => mkdtempSync(join(tmpdir(), 'tollgate-'));
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

// ---------- comment builders ----------
let seq = 0;
const at = (n) => new Date(Date.UTC(2026, 5, 1, 0, n)).toISOString();
const mk = (o = {}) => { const id = ++seq; return { id, pr: 7, review: id, path: 'a.js', body: `finding ${id}`, user: 'alice', bot: false, reply: false, created_at: at(id), url: `https://x/${id}`, commit: 'c1', head: 'h', line: 3, side: 'RIGHT', subject: 'line', text: `const v${id} = ${id};`, ...o }; };
const raw = (o = {}) => { const id = ++seq; return { id, pull_request_review_id: id, pull_request_url: 'https://api.github.com/repos/o/r/pulls/7', path: 'a.js', body: `finding ${id}`, user: { login: 'alice', type: 'User' }, created_at: at(id), html_url: `https://x/${id}`, original_commit_id: 'c1', commit_id: 'head', original_line: 3, side: 'RIGHT', subject_type: 'line', diff_hunk: '@@ -1,3 +1,3 @@\n a\n+const x = 1;', ...o }; };

// ---------- normalize / findings ----------
test('normalize keeps the fixed commit, the original line, the last hunk line and the bot flag', () => {
  const n = normalize(raw({ user: { login: 'Copilot', type: 'Bot' }, diff_hunk: '@@ -1 +1 @@\n context\n+  return value;' }));
  assert.equal(n.commit, 'c1'); assert.equal(n.head, 'head'); assert.equal(n.line, 3); assert.equal(n.pr, 7);
  assert.equal(n.text, 'return value;'); assert.equal(n.bot, true); assert.equal(n.reply, false);
  assert.equal(normalize(raw({ body: '<!-- paragon-review-issue:abc --> ### Bug: x' })).bot, true, 'AI review body from a human account');
  assert.equal(normalize(raw({ in_reply_to_id: 5 })).reply, true);
});

test('isFinding: top-level inline line comments only', () => {
  assert.equal(isFinding(mk()), true);
  assert.equal(isFinding(mk({ reply: true })), false);
  assert.equal(isFinding(mk({ subject: 'file' })), false);
  assert.equal(isFinding(mk({ path: '' })), false);
});

// ---------- rounds ----------
test('rounds: keyed on original_commit_id, so a moving commit_id does not split or merge them', () => {
  const fs = [
    mk({ review: 1, commit: 'c1', head: 'h3' }), mk({ review: 1, commit: 'c1', head: 'h3' }),
    mk({ review: 2, commit: 'c2', head: 'h3' }),
    mk({ review: 3, commit: 'c3', head: 'h3' }),   // same commit_id on every comment: grouping on it would give ONE round
  ];
  const rounds = buildRounds(fs);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map(r => r.commit), ['c1', 'c2', 'c3']);
  assert.deepEqual(rounds.map(r => r.findings.length), [2, 1, 1]);
  assert.equal(fs[3].round, 3);
});

test('rounds: two reviewers on the same commit are one round; order follows the first comment time', () => {
  const rounds = buildRounds([mk({ review: 10, commit: 'cB', created_at: at(500) }), mk({ review: 11, commit: 'cA', created_at: at(100) }), mk({ review: 12, commit: 'cA', user: 'bot', bot: true, created_at: at(101) })]);
  assert.deepEqual(rounds.map(r => r.commit), ['cA', 'cB']);
  assert.equal(rounds[0].reviews.length, 2);
  assert.equal(rounds[0].findings.length, 2);
});

test('rounds: comments with no commit fall back to one round per review and say so', () => {
  const rounds = buildRounds([mk({ review: 1, commit: null }), mk({ review: 2, commit: null })]);
  assert.equal(rounds.length, 2); assert.equal(rounds[0].unknownCommit, true);
});

// ---------- re-flags ----------
test('re-flags: same line text, or half the same words, on the same path only', () => {
  const rounds = buildRounds([
    mk({ review: 1, commit: 'c1', path: 'a.js', body: 'The loop never releases the connection handle before returning early', text: 'const conn = pool.acquire();' }),
    mk({ review: 1, commit: 'c1', path: 'b.js', body: 'Unrelated naming complaint about variables', text: 'let x = 1;' }),
    mk({ review: 2, commit: 'c2', path: 'a.js', body: 'Connection handle still not released before returning early from the loop', text: 'conn2 = something' }),
    mk({ review: 2, commit: 'c2', path: 'c.js', body: 'The loop never releases the connection handle before returning early', text: 'other' }),
    mk({ review: 2, commit: 'c2', path: 'b.js', body: 'something different entirely about tests', text: 'let x = 1;' }),
  ]);
  const pairs = findReflags(rounds);
  const flagged = rounds[1].findings.map(f => !!f.reflag);
  assert.deepEqual(flagged, [true, false, false], 'a.js by words; c.js is a different path; b.js shares only a 10-character line, too short to count');
  assert.equal(pairs.find(p => p.to.path === 'a.js').why, 'same words');
});

test('re-flags: a long identical anchored line counts even when the words differ', () => {
  const rounds = buildRounds([mk({ review: 1, commit: 'c1', body: 'alpha beta gamma', text: 'const result = await fetchEverythingFromTheServer(url);' }), mk({ review: 2, commit: 'c2', body: 'completely other words here now', text: 'const result = await fetchEverythingFromTheServer(url);' })]);
  const [p] = findReflags(rounds);
  assert.equal(p.why, 'same line');
});

// ---------- analysis, views, verdict ----------
test('analysis views: human-only and bot-only rebuild the rounds from their own findings', () => {
  const cs = [mk({ review: 1, commit: 'c1' }), mk({ review: 2, commit: 'c2', bot: true, user: 'bot' }), mk({ review: 3, commit: 'c3', bot: true, user: 'bot' })];
  assert.equal(analyzePr(cs, { view: 'all' }).rounds.length, 3);
  assert.equal(analyzePr(cs, { view: 'human' }).rounds.length, 1);
  assert.equal(analyzePr(cs, { view: 'bot' }).rounds.length, 2);
});

test('verdict: converging, looping, over cap', () => {
  const R = (counts) => counts.map((n, i) => ({ n: i + 1, findings: Array.from({ length: n }, () => ({})) }));
  assert.equal(verdict(R([5, 2, 1]), 0), 'CONVERGING');
  assert.equal(verdict(R([2, 2, 3]), 0), 'LOOPING');
  assert.equal(verdict(R([6, 3, 3]), 4), 'LOOPING');
  assert.equal(verdict(R([2, 1, 1, 1]), 0), 'OVER CAP');
  assert.equal(verdict(R([5, 2, 1, 1]), 0, 5), 'CONVERGING');
  assert.equal(verdict(R([2, 1, 1, 1]), 0, 5), 'LOOPING', 'late findings outnumber round one');
});

// ---------- anchoring against a real git repo ----------
function prRepo() {
  const origin = tmp();
  git(origin, 'init', '-q', '-b', 'main'); git(origin, 'config', 'user.email', 't@t'); git(origin, 'config', 'user.name', 't'); git(origin, 'config', 'commit.gpgsign', 'false');
  const write = (name, lines) => writeFileSync(join(origin, name), lines.join('\n') + '\n');
  const L = (n) => Array.from({ length: n }, (_, i) => `line${i + 1}`);
  write('a.js', L(10)); git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'base');
  git(origin, 'checkout', '-q', '-b', 'feature');
  const a1 = L(10); a1[4] = 'line5 changed in c1'; write('a.js', a1); write('b.js', ['b1', 'b2']); git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'c1'); const c1 = git(origin, 'rev-parse', 'HEAD');
  const a2 = a1.slice(); a2[7] = 'line8 changed in c2'; write('a.js', a2); write('c.js', ['c1']); git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'c2'); const c2 = git(origin, 'rev-parse', 'HEAD');
  const a3 = a2.slice(); a3[1] = 'line2 changed in c3'; write('a.js', a3); git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'c3'); const c3 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/7/head', c3);
  git(origin, 'checkout', '-q', 'main');
  const clone = tmp(); git(clone, 'clone', '-q', origin, '.'); git(clone, 'config', 'user.email', 't@t'); git(clone, 'config', 'user.name', 't');
  return { origin, clone, c1, c2, c3 };
}

test('parseHunks: added ranges only, pure deletions ignored', () => {
  assert.deepEqual(parseHunks('@@ -5 +5 @@\n@@ -8,0 +9,2 @@\n@@ -12,3 +13,0 @@\n@@ -20,2 +22,4 @@'), [[5, 6], [9, 11], [22, 26]]);
});

test('anchoring: unchanged since round one is visible, changed or added later is new, missing commits are unknown', () => {
  const { clone, c1, c2, c3 } = prRepo();
  fetchPrHeads(clone, [7, 999]); // 999 does not exist: one bad ref must not block the good one
  const cs = [
    mk({ review: 1, commit: c1, path: 'a.js', line: 3 }), mk({ review: 1, commit: c1, path: 'a.js', line: 5 }),
    mk({ review: 2, commit: c2, path: 'a.js', line: 3 }),      // untouched since c1: visible
    mk({ review: 2, commit: c2, path: 'a.js', line: 8 }),      // changed in c2: new
    mk({ review: 2, commit: c2, path: 'b.js', line: 1 }),      // b.js untouched since c1: visible
    mk({ review: 2, commit: c2, path: 'c.js', line: 1 }),      // file added after round 1: new
    mk({ review: 3, commit: c3, path: 'a.js', line: 2 }),      // changed in c3: new
    mk({ review: 3, commit: c3, path: 'a.js', line: 10 }),     // visible
    mk({ review: 3, commit: c3, path: 'a.js', line: 8 }),      // changed in c2, still different from c1: new
    mk({ review: 3, commit: 'deadbeef'.repeat(5), path: 'a.js', line: 4 }), // commit not in the repo: unknown
    mk({ review: 3, commit: c3, path: 'a.js', line: 6, side: 'LEFT' }),     // deleted-side comment: unknown
  ];
  const r = analyzePr(cs, { dir: clone });
  const by = (rd, path, line) => r.rounds[rd - 1].findings.find(f => f.path === path && f.line === line);
  assert.equal(r.rounds.length, 3);
  assert.equal(by(2, 'a.js', 3).anchor, 'visible'); assert.equal(by(2, 'a.js', 8).anchor, 'new');
  assert.equal(by(2, 'b.js', 1).anchor, 'visible'); assert.equal(by(2, 'c.js', 1).anchor, 'new');
  assert.equal(by(3, 'a.js', 2).anchor, 'new'); assert.equal(by(3, 'a.js', 10).anchor, 'visible'); assert.equal(by(3, 'a.js', 8).anchor, 'new');
  assert.equal(by(3, 'a.js', 4).anchor, 'unknown'); assert.equal(by(3, 'a.js', 6).anchor, 'unknown');
  assert.equal(r.visible, 3); assert.equal(r.isNew, 4); assert.equal(r.unknown, 2); assert.equal(r.late, 9);
  assert.equal(by(1, 'a.js', 3).anchor, undefined, 'round 1 is never anchored');
});

// ---------- fake GitHub ----------
function fakeGithub(comments, { rateLimitOnce = null } = {}) {
  const hits = []; let limited = false;
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); hits.push(u.pathname + u.search);
    res.setHeader('content-type', 'application/json');
    const m = u.pathname.match(/^\/repos\/o\/r\/pulls\/(?:comments|(\d+)\/comments)$/);
    if (!m) { res.statusCode = 404; return res.end('{}'); }
    const page = Number(u.searchParams.get('page') || 1);
    if (rateLimitOnce && page === rateLimitOnce && !limited) { limited = true; res.statusCode = 403; res.setHeader('x-ratelimit-reset', String(Math.floor(Date.now() / 1000) + 1)); return res.end('{"message":"rate limit"}'); }
    let list = comments;
    if (m[1]) list = comments.filter(c => String(c.pull_request_url).endsWith('/' + m[1]));
    res.end(JSON.stringify(list.slice((page - 1) * 100, page * 100)));
  });
  return new Promise(r => server.listen(0, () => r({ api: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() })));
}

test('crawl: pages ascending, saves progress on a rate limit, resumes from the next page, dedupes', async () => {
  seq = 1000;
  const data = Array.from({ length: 250 }, (_, i) => raw({ id: 5000 + i, pull_request_review_id: 5000 + i }));
  const fake = await fakeGithub(data, { rateLimitOnce: 2 });
  const root = tmp();
  try {
    const first = await crawlComments(root, 'o/r', { since: '2026-01-01T00:00:00.000Z', api: fake.api });
    assert.equal(first.done, false); assert.match(first.partial, /rate limit/); assert.equal(first.items.length, 100);
    const second = await crawlComments(root, 'o/r', { since: '2026-01-01T00:00:00.000Z', api: fake.api });
    assert.equal(second.done, true); assert.equal(second.items.length, 250);
    const pages = fake.hits.map(h => new URL(h, 'http://x').searchParams.get('page'));
    assert.deepEqual(pages, ['1', '2', '2', '3']);
    assert.ok(fake.hits.every(h => h.includes('sort=created') && h.includes('direction=asc') && h.includes('since=')));
    const frozen = await crawlComments(root, 'o/r', { since: '2026-01-01T00:00:00.000Z', api: fake.api, noFetch: true });
    assert.equal(frozen.items.length, 250);
  } finally { fake.close(); }
});

test('crawl: with wait, a rate limit sleeps and continues in the same call', async () => {
  seq = 2000;
  const data = Array.from({ length: 150 }, (_, i) => raw({ id: 9000 + i, pull_request_review_id: 9000 + i }));
  const fake = await fakeGithub(data, { rateLimitOnce: 2 });
  try {
    const r = await crawlComments(tmp(), 'o/r', { since: '2026-01-01T00:00:00.000Z', api: fake.api, wait: true, pad: 0 });
    assert.equal(r.done, true); assert.equal(r.items.length, 150);
  } finally { fake.close(); }
});

test('scan end to end: rounds, visible-in-round-one, re-flags, cap simulation, boundary guard', async () => {
  const { clone, origin, c1, c2, c3 } = prRepo();
  git(origin, 'checkout', '-q', 'feature'); // c4 so a PR can have a round over the cap
  writeFileSync(join(origin, 'a.js'), 'x\n'); git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'c4'); const c4 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/7/head', c4); git(origin, 'checkout', '-q', 'main');
  const day = (n) => new Date(Date.now() - 60 * 86400e3 + n * 60000).toISOString();
  const pr = (n) => `https://api.github.com/repos/o/r/pulls/${n}`;
  const comments = [
    // PR 7: four rounds, one visible in round 1 at round 2, a re-flag at round 3, one finding after the cap (round 4)
    raw({ id: 1, pull_request_url: pr(7), pull_request_review_id: 1, original_commit_id: c1, original_line: 5, created_at: day(1), body: 'Handle the empty list case before indexing into the array' }),
    raw({ id: 2, pull_request_url: pr(7), pull_request_review_id: 2, original_commit_id: c2, original_line: 3, created_at: day(2), body: 'Totally separate remark about naming' }),
    raw({ id: 3, pull_request_url: pr(7), pull_request_review_id: 3, original_commit_id: c3, original_line: 5, created_at: day(3), body: 'Still need to handle the empty list case before indexing the array' }),
    raw({ id: 4, pull_request_url: pr(7), pull_request_review_id: 4, original_commit_id: c4, original_line: 1, created_at: day(4), body: 'Fresh complaint about the new line' }),
    // PR 8: one round
    raw({ id: 5, pull_request_url: pr(8), pull_request_review_id: 5, original_commit_id: c1, original_line: 3, created_at: day(5), body: 'Single remark' }),
    // PR 9: first comment inside the boundary guard (first 14 days): dropped
    raw({ id: 6, pull_request_url: pr(9), pull_request_review_id: 6, original_commit_id: c1, original_line: 3, created_at: new Date(Date.now() - 175 * 86400e3).toISOString(), body: 'Old' }),
    // a reply and a file-level comment: not findings
    raw({ id: 7, pull_request_url: pr(8), pull_request_review_id: 7, original_commit_id: c1, original_line: 3, in_reply_to_id: 5, created_at: day(6), body: 'thanks' }),
    raw({ id: 8, pull_request_url: pr(8), pull_request_review_id: 8, original_commit_id: c1, original_line: null, subject_type: 'file', created_at: day(7), body: 'file level' }),
  ];
  const fake = await fakeGithub(comments);
  try {
    const r = await scanRepo({ repo: 'o/r', days: 180, dir: clone, root: clone, api: fake.api, cache: false });
    assert.equal(r.complete, true); assert.equal(r.comments, 8);
    assert.equal(r.prsWithComments, 3); assert.equal(r.prsInWindow, 2, 'PR 9 dropped by the boundary guard');
    const a = r.views.all;
    assert.equal(a.prs, 2); assert.deepEqual(a.rounds, { 1: 1, 2: 0, 3: 0, 4: 1, '5+': 0 }); assert.equal(a.max, 4);
    assert.equal(a.pct3, 50); assert.equal(a.pct5, 0);
    assert.equal(a.late, 3); assert.equal(a.reflagged, 1);
    // c2 line 3 visible; c3 line 5 changed in c1 itself so visible vs c1 (c1 is round 1); c4 line 1 of a.js rewritten in c4: new
    assert.equal(a.visible, 2); assert.equal(a.isNew, 1); assert.equal(a.visiblePct, 66.7);
    assert.equal(a.overCap, 1); assert.equal(a.afterCap, 1); assert.equal(a.afterCapNew, 1); assert.equal(a.afterCapVisible, 0);
    assert.ok(formatScan(r).includes('PRs in window'));
    assert.ok(formatPr(a.results.find(p => p.pr === 7)).includes('OVER CAP'));
  } finally { fake.close(); }
});

test('goNoGo: the pre-registered thresholds', () => {
  assert.equal(goNoGo({ pct3: 12, visiblePct: 30, reflagPct: 2 }).go, true);
  assert.equal(goNoGo({ pct3: 12, visiblePct: 5, reflagPct: 11 }).go, true, 're-flag rate alone satisfies part b');
  assert.equal(goNoGo({ pct3: 9, visiblePct: 60, reflagPct: 20 }).go, false, 'too few PRs reach 3 rounds');
  assert.equal(goNoGo({ pct3: 30, visiblePct: 10, reflagPct: 5 }).go, false, 'late findings are not old code and not repeats');
});

// ---------- cli ----------
test('cli: pr prints rounds from the API and anchors inside a clone; --json parses; help prints', async () => {
  const { clone, origin, c1, c2, c3 } = prRepo();
  const comments = [
    raw({ id: 31, pull_request_review_id: 31, original_commit_id: c1, original_line: 3, created_at: at(1), body: 'First remark about the helper' }),
    raw({ id: 32, pull_request_review_id: 32, original_commit_id: c2, original_line: 3, created_at: at(2), body: 'Second remark about the helper again' }),
  ];
  const fake = await fakeGithub(comments);
  try {
    // async spawn: the fake server lives in this process, a blocking spawnSync would deadlock it
    const run = (...a) => new Promise((res) => { const c = spawn(process.execPath, [SCRIPT, ...a], { cwd: clone }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
    const out = await run('pr', '7', '--repo', 'o/r', '--api', fake.api);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /PR #7/); assert.match(out.stdout, /2 rounds/); assert.match(out.stdout, /CONVERGING/); assert.match(out.stdout, /visible in round one: 1/);
    const j = JSON.parse((await run('pr', '7', '--repo', 'o/r', '--api', fake.api, '--json')).stdout);
    assert.equal(j.rounds.length, 2); assert.equal(j.visible, 1);
    assert.match((await run('--help')).stdout, /tollgate pr <number\|url>/);
    assert.equal((await run('nonsense')).status, 2);
  } finally { fake.close(); }
});

test('tokens: the same word reduction grudge uses', () => {
  assert.ok(tokens('Please avoid `await t.test` here, see https://x.y').includes('await'));
  assert.ok(!tokens('the and of').length);
});
