#!/usr/bin/env node
// Claude Code Stop hook. Maps the tollgate verdict to an explicit decision; it never passes the CLI exit code
// through (the CLI uses 3 for ESCALATE, Claude Code reads exit 2 as "block").
//
//   PASS      allow the stop
//   BLOCK     block the stop once, naming the open findings (exit 2, reason on stderr)
//   ESCALATE  allow the stop: forcing round 4, 5 and beyond is the loop tollgate exists to stop. Block once only
//             to ask the final message to say it escalated, with the number of blocking findings still open.
//   stop_hook_active, or no ledger for this branch: allow, and say nothing.
//
// A ledger exists only where an agent or a person ran `tollgate add`, so this does nothing in other repos.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { repoRoot, currentBranch, hasLedger, gateLocal } from '../skills/tollgate/scripts/tollgate.js';

export function stopDecision(input) {
  if (input.stop_hook_active) return { allow: true };
  const root = repoRoot(input.cwd || process.cwd());
  const branch = currentBranch(root);
  if (!hasLedger(root, branch)) return { allow: true };
  const g = gateLocal(root, branch);
  if (g.verdict === 'PASS') return { allow: true, g };
  const list = g.openFindings.filter(f => f.severity !== 'nit').slice(0, 5).map(f => `${f.id} ${f.file}${f.line ? ':' + f.line : ''}`).join(', ');
  if (g.verdict === 'BLOCK') {
    return { allow: false, g, reason: `tollgate: ${g.blocking} blocking finding(s) still open in round ${g.round} of cap ${g.cap} (${list}). Resolve each with "tollgate resolve <id> --fixed <sha>" or --waive "<reason>", then say what you did. Do not call the review done while findings are open.` };
  }
  const msg = String(input.last_assistant_message || '');
  const said = /escalat/i.test(msg) && new RegExp(`\\b${g.blocking}\\b`).test(msg);
  if (said) return { allow: true, g };
  return { allow: false, g, reason: `tollgate: round ${g.round} is over the cap of ${g.cap} with ${g.blocking} blocking finding(s) still open (${list}). Do not start another round. End your message by saying you escalated and that ${g.blocking} finding(s) are open, so a human decides.` };
}

const samePath = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input; try { input = JSON.parse(raw); } catch { process.exit(0); }
    let d; try { d = stopDecision(input); } catch { process.exit(0); } // a broken ledger must never trap the agent
    if (d.allow) process.exit(0);
    process.stderr.write(d.reason + '\n');
    process.exit(2);
  });
}
