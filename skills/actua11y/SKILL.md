---
name: actua11y
description: An accessibility audit for coding agents that is honest about what a machine settled and what still needs a person. Audits a site against WCAG 2.2 (A, AA or AAA) with a fresh, isolated, read-only session that drives a real browser, then files two GitHub issues, one for agents (every proven fail, with file, line and repro steps) and one for a person (everything a machine can't settle). Use when someone asks for an accessibility audit, an a11y review, WCAG conformance, or "is this accessible?". It never says a site passes.
license: MIT for code, CC BY 4.0 for prose. See LICENSE in github.com/AhoyLemon/skills.
compatibility: Claude Code, with Node 22.18 or later, git, the GitHub CLI signed in, and Chrome or Edge installed.
metadata:
  author: Lemon
  version: 0.1.0
allowed-tools: Read(${CLAUDE_SKILL_DIR}/**) Bash(node ${CLAUDE_SKILL_DIR}/runner.ts *)
---

# actua11y

The "well, actually" to "we're basically done with accessibility".

**A machine can prove a fail, and it can never prove a pass.** Everything here follows from that. Nothing you write in this skill, in an issue, a comment or a summary, ever says the target "passes", "complies" or "conforms".

**Say this first, every run, in your own words or these:** actua11y is Lemon's best-faith effort, and it guarantees nothing. It's a floor, not a certificate. The runner prints the same line, and every issue it files carries it.

## The four verdicts

Every WCAG criterion at the target gets exactly one. The runner computes it from the finder's findings, so no model ever writes a verdict.

| Verdict | Means | Owes you |
|---|---|---|
| ✅ | A machine found no fail, by doing something specific | The evidence, so anyone can challenge it |
| ❌ | A machine proved a fail | `file:line`, who it hurts, and exact repro steps when it's behaviour |
| 🕵️ | A machine can't settle it | What a person should check, and how |
| n/a | The criterion doesn't apply | A one-line reason |

There is no fourth state. Anything measured and then left undecided is a 🕵️ with its own line.

## How it runs

You, in the user's own session, are the orchestrator: you do the intake, call the runner, and report. A separate, fresh session (the finder) does the audit, read-only and blind to this conversation. The runner starts it, validates its report and files the issues. You never file, render or paraphrase findings yourself.

The runner lives in this skill's base directory. Call it as `node <base directory>/runner.ts <command>`, from inside the repository being audited. Run `node --version` first: it needs 22.18 or later.

### 0. Intake

Ask these together where you can, and keep it brisk.

- **The target level: A, AA or AAA.** Levels are cumulative (AA means A and AA). If the project names a standard (a contract, an accessibility statement, the README), offer that. Otherwise ask, with all three as real options.
- **At AAA, warn before anything runs**, something like: "AAA it is. I'll do my best, but this is a best effort, not a claim. Real AAA conformance needs a qualified accessibility specialist and testing with disabled people, and WCAG itself doesn't recommend AAA as a blanket target for a whole site." The runner and both issues repeat it.
- **The scope.** What the user names, or a stated assumption they can correct in a word ("the whole site", "these pages", "this branch's changes"). Pass paths with `--scope`, and pages with `--page` if they named them. Otherwise the finder finds the pages itself.
- **The running site.** A URL for a dev server that's already up (`--url`), or a folder for a static site, which the runner serves on localhost for the run (`--serve <folder>`). If the site needs a dev server and none is running, ask before starting one.
- **Why a real browser.** Say it plainly: the finder drives the user's installed Chrome or Edge, headless, because keyboard behaviour, focus and rendered contrast only exist once a page is running. Some people don't want that by default, so they should hear why.
- **Filing.** Say where it will file: two issues on this repository's GitHub, one for agents, and one for a person, assigned to them. Get their OK before the first real run.
- **Cost.** The finder defaults to `claude-opus-5-5` at effort `high`, capped at 300 turns, $20 and 60 minutes. Say so, and pass `--model`, `--effort`, `--max-turns`, `--max-budget-usd` or `--timeout-minutes` if they want different.

### 1. Preflight

`node <base>/runner.ts preflight --level <L> [--scope ...] (--url <url> | --serve <folder>)`

It refuses on any ✗ and prints a fix for each:

- the working tree must be clean and level with its remote
- no gitignored strays (a `node_modules`, a stray `package.json`) inside the scope
- `gh` must be signed in, with issues on
- Node must be 22.18 or later
- a browser must actually launch
- the site must answer

Relay each ✗ and its fix, and don't start until it's clean. If a gitignored path genuinely belongs inside the scope, ask, then pass `--allow-ignored <path>`. The finder is barred from reading it. A `!` line is a warning to mention, not a blocker.

### 2. Dry run

`node <base>/runner.ts dry-run` (with the same `--model` and `--effort` the finder will use)

Before the first real run in a session, this starts a fresh session with no tools, isolated exactly like the finder, and asks it what it loaded. The runner checks the mechanical part itself. Then you read its answer. It should name no instruction files, memory, skills, plugins, MCP servers or hooks, and know nothing about the repository beyond its path (it will know the signed-in account, which is expected). If it names anything else, stop and show the user. A run refuses to start without a clean dry run from the last six hours.

### 3. The finder

`node <base>/runner.ts run finder --level <L> [--scope ...] (--url <url> | --serve <folder>) [--page ...] [--allow-ignored ...]`

This takes a while. Run it in the background if you can, and tell the user roughly how long and what it costs. When it finishes, relay the tally, the cost and the run id. If it says the finder changed the repository, stop and show the user before anything else. If it couldn't get a usable report, say so plainly, with the path it printed.

### 4. File

`node <base>/runner.ts file --run <run-id>`

This files both issues, cross-links them and attaches the raw report. `--preview` writes the bodies locally instead, if the user wants to see them first. If filing stops partway, run the same command again, and it picks up where it stopped.

### 5. Stop

This version is assess-only, so it ends here. Tell the user:

- where each issue is
- how many fails went to agents, and how many checks went to them
- what it cost (the runner prints it)
- that the person's issue is the part only they can do

The fix-and-certify loop comes in a later version. Don't start fixing things yourself as part of this skill.

## Never

- Say or imply the site passes, complies or conforms, anywhere.
- Paraphrase, summarise or re-rank the finder's findings as if they were yours. The issues are the record.
- File, edit or comment on issues by hand. The runner does it, every time.
- Edit the repository being audited during an assess-only run.
- Fake independence. If the runner can't start an isolated session here, say so and stop.

## Files

- `runner.ts`: the commands above. Everything agent-neutral lives behind it.
- `briefs/finder.md`, `briefs/dry-run.md`: what the fresh sessions are told, filled in by the runner.
- `data/wcag22.json`: the WCAG 2.2 criteria and levels, generated from W3C's data. Levels come from here, never from memory.
- `kit/`: the browser scripts each run installs into its own scratch folder.
- `references/claude-code.md`: how isolation works in Claude Code, and its known limits.
- `CHANGELOG.md`
