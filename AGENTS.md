# tollgate — instructions for coding agents

You are reading this because a user pasted something like:

> Install the tollgate skill from https://github.com/codegobrrrr9/tollgate, refer to the repo's AGENTS.md.

Do the install for the agent you are, confirm in one line, then follow the rules below for the rest
of the session. Do not explain what tollgate is unless asked.

## Install

`<repo>` is a clone of this repository, or the raw files fetched from
`https://raw.githubusercontent.com/codegobrrrr9/tollgate/main/`.

| Agent | Do this |
|-------|---------|
| Claude Code | Run `/plugin marketplace add codegobrrrr9/tollgate` then `/plugin install tollgate@tollgate`. The plugin ships a Stop hook: while the branch ledger has open blocking findings the agent is told to resolve or waive them, and past the round cap it must say it escalated. If plugins are unavailable, copy `<repo>/skills/tollgate/` to `~/.claude/skills/tollgate/` and add the hooks block below to `~/.claude/settings.json`. |
| Codex | Copy `<repo>/skills/tollgate/` to `~/.codex/skills/tollgate/`, or run `npx skills add codegobrrrr9/tollgate`. Append the **Rules** below to the project's `AGENTS.md`. |
| Cursor | Copy `<repo>/.cursor/rules/tollgate.mdc` to `.cursor/rules/`, and `<repo>/skills/tollgate/scripts/tollgate.js` to `scripts/tollgate.js`. |
| Gemini CLI | Run `gemini extensions install https://github.com/codegobrrrr9/tollgate`. |
| GitHub Copilot | Copy `<repo>/.github/copilot-instructions.md` into the project's `.github/`. |
| Anything else | Append the **Rules** below to the agent's instruction file and keep `tollgate.js` in the project. |

Hooks block for a non-plugin Claude Code install (`~/.claude/settings.json`), with `<repo>` the cloned repo:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<repo>/hooks/stop.js\"", "timeout": 15 }] }]
  }
}
```

If the project has CI on GitHub Actions and the user wants the PR check, add `uses: codegobrrrr9/tollgate@v1`
with `permissions: pull-requests: read` (see the README). Ask before editing a workflow.

After installing, say: `tollgate on. I will record review findings, answer each with a sha or a reason, and stop at the round cap.`

## Rules

1. **Reviewer: one pass, everything.** Every finding you would raise, ranked, each marked `--blocking` or
   `--nit`, each with file and line, recorded with `tollgate add`. Do not drip-feed.
2. **Never re-raise a resolved or waived finding without saying why.** `REOPENED: fix incomplete` means the
   fix did not work; a waived finding needs `--reason`.
3. **Author: answer every open finding** with `tollgate resolve <id> --fixed <sha>` or `--waive "<reason>"`.
   Never say "addressed" unless the ledger shows it.
4. **After pushing fixes, run `tollgate round`.**
5. **Before you say a review is done, run `tollgate status`** and end with its line.
6. **ESCALATE means stop.** Do not start another round. Say you escalated, give the number of blocking
   findings still open, and list them. A human decides.
7. Never edit `.tollgate/` by hand.

## Commands

```
tollgate.js add --file f --line n --text "..." [--code "<line>"] [--nit|--blocking] [--reason "..."]
tollgate.js resolve <id> --fixed <sha> | --waive "<reason>"
tollgate.js round | status | gate        gate: exit 0 PASS, 1 BLOCK, 3 ESCALATE
tollgate.js pr <n|url> [--repo o/r] [--dir .]    analyse a GitHub PR
tollgate.js scan --repo o/r [--days 180]         the same over a repo
```
