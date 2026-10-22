import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { addFinding, resolveFinding, nextRound, gateLocal, loadLedger, decide, EXIT, readConfig, ledgerFile, formatStatus, gateGithub, fetchThreads, gateMarkdown } from '../skills/tollgate/scripts/tollgate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'skills', 'tollgate', 'scripts', 'tollgate.js');
const repo = () => { const d = mkdtempSync(join(tmpdir(), 'tg-led-')); spawnSync('git', ['init', '-q', '-b', 'feature'], { cwd: d }); return d; };
const cli = (cwd, ...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd, encoding: 'utf8' });
const B = 'feature';

test('add, gate BLOCK, resolve fixed, gate PASS', () => {
  const d = repo();
  const r = addFinding(d, B, { file: 'src/a.js', line: 10, text: 'The loop never releases the connection handle before returning early' });
  assert.equal(r.kind, 'new'); assert.equal(r.id, 't-1');
  let g = gateLocal(d, B); assert.equal(g.verdict, 'BLOCK'); assert.equal(g.blocking, 1);
  assert.equal(cli(d, 'gate').status, 1);
  assert.deepEqual(resolveFinding(d, B, 't-1', { fixed: 'abc1234' }), { id: 't-1', status: 'fixed', sha: 'abc1234' });
  g = gateLocal(d, B); assert.equal(g.verdict, 'PASS'); assert.equal(g.fixed, 1);
  assert.equal(cli(d, 'gate').status, 0);
});

test('a nit never blocks', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'rename this variable to something clearer please', severity: 'nit' });
  const g = gateLocal(d, B); assert.equal(g.verdict, 'PASS'); assert.equal(g.nits, 1); assert.equal(g.blocking, 0);
});

test('re-flag of an OPEN finding is a repeat: counted, no second finding', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  const r = addFinding(d, B, { file: 'a.js', text: 'You still need to handle the empty list case before indexing the array' });
  assert.equal(r.kind, 'repeat'); assert.equal(r.of, 't-1');
  const g = gateLocal(d, B); assert.equal(g.open, 1); assert.equal(g.repeats, 1);
});

test('re-flag of a FIXED finding is recorded as REOPENED: fix incomplete, with the original sha', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  resolveFinding(d, B, 't-1', { fixed: 'deadbee1234' });
  const r = addFinding(d, B, { file: 'a.js', text: 'Empty list case is still not handled before indexing the array' });
  assert.equal(r.kind, 'reopened'); assert.equal(r.of, 't-1'); assert.equal(r.fixSha, 'deadbee1234'); assert.equal(r.id, 't-2');
  const g = gateLocal(d, B); assert.equal(g.reopened, 1); assert.equal(g.open, 1);
  assert.match(formatStatus(g), /REOPENED: fix incomplete, was fixed in deadbee/);
});

test('re-flag of a WAIVED finding needs a reason; it is refused without one, recorded with one, waiver shown', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  resolveFinding(d, B, 't-1', { waive: 'callers guarantee a non-empty list' });
  const refused = addFinding(d, B, { file: 'a.js', text: 'Empty list case is not handled before indexing the array' });
  assert.equal(refused.kind, 'needs-reason'); assert.equal(refused.waiver, 'callers guarantee a non-empty list');
  assert.equal(loadLedger(d, B).findings.size, 1, 'nothing recorded');
  const ok = addFinding(d, B, { file: 'a.js', text: 'Empty list case is not handled before indexing the array', reason: 'a new caller passes user input' });
  assert.equal(ok.kind, 'reflag-waived'); assert.equal(ok.waiver, 'callers guarantee a non-empty list');
  // once t-2 is open, a further repeat is a repeat of t-2; the refusal is for a waived finding, shown on the command line:
  const d2 = repo();
  cli(d2, 'add', '--file', 'a.js', '--text', 'Handle the empty list case before indexing into the array');
  cli(d2, 'resolve', 't-1', '--waive', 'callers guarantee a non-empty list');
  const cliRefused = cli(d2, 'add', '--file', 'a.js', '--text', 'Empty list case is not handled before indexing the array');
  assert.equal(cliRefused.status, 4); assert.match(cliRefused.stderr, /needs --reason/);
  assert.equal(cli(d2, 'add', '--file', 'a.js', '--text', 'Empty list case is not handled before indexing the array', '--reason', 'new caller passes user input').status, 0);
});

test('a different file or different words is a new finding, not a re-flag', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  assert.equal(addFinding(d, B, { file: 'b.js', text: 'Handle the empty list case before indexing into the array' }).kind, 'new');
  assert.equal(addFinding(d, B, { file: 'a.js', text: 'Rename the helper to describe what it returns' }).kind, 'new');
  assert.equal(addFinding(d, B, { file: 'c.js', text: 'x', code: 'const result = await fetchEverythingFromTheServer(url);' }).kind, 'new');
  assert.equal(addFinding(d, B, { file: 'c.js', text: 'totally different words entirely here', code: 'const result = await fetchEverythingFromTheServer(url);' }).kind, 'repeat', 'same long line text counts');
});

test('resolve validates: unknown id, already resolved, missing sha, short waiver', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  assert.throws(() => resolveFinding(d, B, 't-9', { fixed: 'x' }), /no finding t-9/);
  assert.throws(() => resolveFinding(d, B, 't-1', {}), /needs --fixed/);
  assert.throws(() => resolveFinding(d, B, 't-1', { waive: 'no' }), /5 characters/);
  resolveFinding(d, B, 't-1', { fixed: 'abc' });
  assert.throws(() => resolveFinding(d, B, 't-1', { fixed: 'abc' }), /already fixed/);
});

test('rounds and the cap: ESCALATE only with blocking findings open past the cap; PASS when nothing is open', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  assert.equal(gateLocal(d, B).verdict, 'BLOCK');
  nextRound(d, B); nextRound(d, B);
  let g = gateLocal(d, B); assert.equal(g.round, 3); assert.equal(g.verdict, 'BLOCK', 'round 3 is still within a cap of 3');
  nextRound(d, B);
  g = gateLocal(d, B); assert.equal(g.round, 4); assert.equal(g.verdict, 'ESCALATE');
  assert.equal(cli(d, 'gate').status, EXIT.ESCALATE); assert.equal(EXIT.ESCALATE, 3);
  assert.equal(gateLocal(d, B, 5).verdict, 'BLOCK', 'a higher cap');
  resolveFinding(d, B, 't-1', { waive: 'accepted by the maintainer' });
  assert.equal(gateLocal(d, B).verdict, 'PASS', 'over the cap with nothing open is PASS');
});

test('branch scoping and .tollgate.json cap', () => {
  const d = repo();
  addFinding(d, 'feature', { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  assert.equal(gateLocal(d, 'other').open, 0);
  assert.equal(cli(d, 'status', '--branch', 'other').status, 0);
  writeFileSync(join(d, '.tollgate.json'), JSON.stringify({ cap: 1 }));
  assert.equal(readConfig(d).cap, 1);
  nextRound(d, 'feature');
  assert.equal(gateLocal(d, 'feature').verdict, 'ESCALATE');
  assert.equal(cli(d, 'gate', '--cap', '9').status, 1, '--cap overrides the file');
});

test('ledger is append-only json lines and re-reading is stable', () => {
  const d = repo();
  addFinding(d, B, { file: 'a.js', text: 'Handle the empty list case before indexing into the array' });
  resolveFinding(d, B, 't-1', { fixed: 'abc' });
  const lines = readFileSync(ledgerFile(d), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.type), ['add', 'fixed']);
  assert.ok(lines.every(l => l.branch === B && l.t));
  assert.deepEqual([...loadLedger(d, B).findings.keys()], [...loadLedger(d, B).findings.keys()]);
});

test('cli: the whole loop through the command line', () => {
  const d = repo();
  assert.match(cli(d, 'add', '--file', 'src/a.js', '--line', '4', '--text', 'Check the null case before dereferencing the result').stdout, /added t-1 \(round 1\)/);
  assert.match(cli(d, 'status').stdout, /BLOCK.*open 1 \(1 blocking\)/);
  assert.match(cli(d, 'resolve', 't-1', '--fixed', 'cafe123').stdout, /t-1 fixed in cafe123/);
  assert.equal(cli(d, 'round').stdout.trim(), 'round 2');
  assert.match(cli(d, 'add', '--file', 'src/a.js', '--text', 'Null case is still not checked before dereferencing the result').stdout, /REOPENED t-2: fix incomplete, t-1 was fixed in cafe123/);
  const j = JSON.parse(cli(d, 'status', '--json').stdout); assert.equal(j.reopened, 1); assert.equal(j.round, 2);
  assert.equal(cli(d, 'resolve', 't-9', '--fixed', 'x').status, 1);
});

test('decide: the one verdict rule', () => {
  assert.equal(decide({ round: 1, cap: 3, blocking: 0 }), 'PASS');
  assert.equal(decide({ round: 3, cap: 3, blocking: 2 }), 'BLOCK');
  assert.equal(decide({ round: 4, cap: 3, blocking: 2 }), 'ESCALATE');
  assert.equal(decide({ round: 9, cap: 3, blocking: 0 }), 'PASS');
});

// ---------- GitHub review threads (GraphQL) ----------
function fakeGh({ threads, comments }) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/graphql') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        if (!/Bearer /.test(req.headers.authorization || '')) { res.statusCode = 401; return res.end('{}'); }
        res.end(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } }));
      }); return;
    }
    if (/^\/repos\/o\/r\/pulls\/\d+\/comments/.test(req.url)) return res.end(JSON.stringify(comments));
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(r => server.listen(0, () => r({ api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const thread = (o = {}) => ({ isResolved: false, isOutdated: false, path: 'a.js', line: 3, comments: { nodes: [{ body: 'Handle the empty case', url: 'https://x/1', author: { login: 'bot' } }] }, ...o });
const rc = (id, commit, over = {}) => ({ id, pull_request_review_id: id, pull_request_url: 'https://api.github.com/repos/o/r/pulls/7', path: 'a.js', body: 'remark ' + id, user: { login: 'bot', type: 'Bot' }, created_at: new Date(Date.UTC(2026, 5, 1, 0, id)).toISOString(), html_url: 'u', original_commit_id: commit, commit_id: commit, original_line: 3, side: 'RIGHT', subject_type: 'line', diff_hunk: '@@ -1 +1 @@\n+x', ...over });

test('gate --github: unresolved non-nit threads block, nits do not, rounds past the cap escalate', async () => {
  const comments = ['c1', 'c2', 'c3', 'c4'].map((c, i) => rc(i + 1, c));
  const fake = await fakeGh({ threads: [thread(), thread({ isResolved: true }), thread({ comments: { nodes: [{ body: 'nit: spelling', url: 'u', author: { login: 'h' } }] } })], comments });
  try {
    const g = await gateGithub({ repo: 'o/r', pr: 7, cap: 3, api: fake.api, token: 't' });
    assert.equal(g.rounds, 4); assert.equal(g.threads, 3); assert.equal(g.open, 2); assert.equal(g.blocking, 1); assert.equal(g.nits, 1);
    assert.equal(g.verdict, 'ESCALATE');
    assert.equal((await gateGithub({ repo: 'o/r', pr: 7, cap: 5, api: fake.api, token: 't' })).verdict, 'BLOCK');
    assert.match(gateMarkdown(g), /### tollgate: ESCALATE/);
    await assert.rejects(() => gateGithub({ repo: 'o/r', pr: 7, api: fake.api, token: '' }), /needs a token/);
  } finally { fake.close(); }
});

test('gate --github on the command line: outputs file, step summary, and --fail-on', async () => {
  const comments = [rc(1, 'c1'), rc(2, 'c2')];
  const fake = await fakeGh({ threads: [thread()], comments });
  const dir = mkdtempSync(join(tmpdir(), 'tg-gh-'));
  const run = (...a) => new Promise((res) => { const c = spawn(process.execPath, [SCRIPT, 'gate', '--github', '--pr', '7', '--repo', 'o/r', '--api', fake.api, ...a], { cwd: dir, env: { ...process.env, GITHUB_TOKEN: 't', GITHUB_OUTPUT: join(dir, 'out.txt'), GITHUB_STEP_SUMMARY: join(dir, 'sum.md') } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
  try {
    const never = await run(); assert.equal(never.status, 0, 'report-only by default'); assert.match(never.stdout, /BLOCK/);
    assert.match(readFileSync(join(dir, 'out.txt'), 'utf8'), /verdict=BLOCK\nrounds=2\nopen=1\nblocking=1\ncap=3/);
    assert.match(readFileSync(join(dir, 'sum.md'), 'utf8'), /### tollgate: BLOCK/);
    assert.equal((await run('--fail-on', 'block')).status, 1);
    assert.equal((await run('--fail-on', 'escalate')).status, 0, 'BLOCK is not an ESCALATE');
    assert.equal((await run('--fail-on', 'escalate', '--cap', '1')).status, 3);
  } finally { fake.close(); }
});

test('action.yml: no unquoted scalar holds ": " (GitHub refuses to load the manifest), description fits the Marketplace', () => {
  const lines = readFileSync(join(ROOT, 'action.yml'), 'utf8').split('\n');
  for (const l of lines) {
    const m = l.match(/^\s*(?:[\w-]+): (.+)$/);
    if (!m || /^['"|>]/.test(m[1])) continue;
    assert.ok(!m[1].includes(': '), `unquoted value with ": " would break the manifest: ${l.trim()}`);
  }
  const d = lines.find(l => l.startsWith('description:')).slice('description:'.length).trim().replace(/^'|'$/g, '');
  assert.ok(d.length <= 125, `Marketplace caps the description at 125, this is ${d.length}`);
});
