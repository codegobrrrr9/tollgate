import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addFinding, resolveFinding, nextRound } from '../skills/tollgate/scripts/tollgate.js';
import { stopDecision } from '../hooks/stop.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOP = join(ROOT, 'hooks', 'stop.js');
const repo = () => { const d = mkdtempSync(join(tmpdir(), 'tg-hook-')); spawnSync('git', ['init', '-q', '-b', 'feature'], { cwd: d }); return d; };
const hook = (input) => { const t = Date.now(); const r = spawnSync(process.execPath, [STOP], { input: JSON.stringify(input), encoding: 'utf8' }); return { code: r.status, err: r.stderr, out: r.stdout, ms: Date.now() - t }; };
const add = (d, text = 'Handle the empty list case before indexing into the array') => addFinding(d, 'feature', { file: 'a.js', text });

test('stop hook: hooks.json is a Stop hook with a timeout and no PreToolUse', () => {
  const j = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(j.hooks), ['Stop']);
  assert.match(j.hooks.Stop[0].hooks[0].command, /CLAUDE_PLUGIN_ROOT.*hooks\/stop\.js/);
  assert.ok(j.hooks.Stop[0].hooks[0].timeout > 0);
});

test('stop hook: silent and allowing where there is no ledger', () => {
  const d = repo();
  const r = hook({ cwd: d, last_assistant_message: 'All done.' });
  assert.equal(r.code, 0); assert.equal(r.err, ''); assert.equal(r.out, '');
});

test('stop hook: PASS allows, BLOCK blocks once naming the findings, stop_hook_active allows', () => {
  const d = repo(); add(d);
  const blocked = hook({ cwd: d, last_assistant_message: 'Review complete.' });
  assert.equal(blocked.code, 2); assert.match(blocked.err, /1 blocking finding\(s\) still open/); assert.match(blocked.err, /t-1 a\.js/); assert.match(blocked.err, /tollgate resolve/);
  assert.equal(hook({ cwd: d, stop_hook_active: true, last_assistant_message: 'Review complete.' }).code, 0, 'never traps the agent in a loop');
  resolveFinding(d, 'feature', 't-1', { fixed: 'abc1234' });
  assert.equal(hook({ cwd: d, last_assistant_message: 'Review complete.' }).code, 0);
});

test('stop hook: ESCALATE allows the stop, but asks once for the statement; with it, or with stop_hook_active, it allows', () => {
  const d = repo(); add(d); add(d, 'Rename the helper so it describes what it returns'); nextRound(d, 'feature'); nextRound(d, 'feature'); nextRound(d, 'feature');
  const ask = hook({ cwd: d, last_assistant_message: 'Fixed what I could.' });
  assert.equal(ask.code, 2); assert.match(ask.err, /over the cap of 3/); assert.match(ask.err, /Do not start another round/); assert.match(ask.err, /escalated/);
  assert.equal(hook({ cwd: d, last_assistant_message: 'Round 4 is over the cap. I escalated: 2 blocking findings are open, a human decides.' }).code, 0);
  assert.equal(hook({ cwd: d, last_assistant_message: 'I escalated this.' }).code, 2, 'the open count must be there too');
  assert.equal(hook({ cwd: d, stop_hook_active: true, last_assistant_message: 'Fixed what I could.' }).code, 0);
});

test('stop hook: the verdict is mapped, not the CLI exit code (ESCALATE is 3 for the CLI and never 3 here)', () => {
  const d = repo(); add(d); nextRound(d, 'feature'); nextRound(d, 'feature'); nextRound(d, 'feature');
  const r = hook({ cwd: d, last_assistant_message: 'x' });
  assert.notEqual(r.code, 3); assert.ok([0, 2].includes(r.code));
  const dec = stopDecision({ cwd: d, last_assistant_message: 'I escalated; 1 blocking finding open.' });
  assert.equal(dec.allow, true); assert.equal(dec.g.verdict, 'ESCALATE');
});

test('stop hook: a broken input or ledger never traps the agent, and it is fast', () => {
  const d = repo();
  assert.equal(spawnSync(process.execPath, [STOP], { input: 'not json', encoding: 'utf8' }).status, 0);
  assert.equal(hook({ cwd: join(d, 'missing-dir') }).code, 0);
  assert.ok(hook({ cwd: d }).ms < 3000);
});
