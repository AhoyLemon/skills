---
name: actua11y
description: An accessibility audit and fix loop for coding agents that is honest about what a machine settled and what still needs a person. Audits a site against WCAG 2.2 (A, AA or AAA) with a fresh, isolated, read-only session that drives a real browser, files two GitHub issues (every proven fail for agents, everything a machine can't settle for a person), then, if you want, fixes the fails, has a blind certifier check every fix, hands the rest to a person who works it with the fixer while a certifier guards every fix, and closes both issues with one PR. Use when someone asks for an accessibility audit, an a11y review, WCAG conformance, "is this accessible?", or to fix accessibility issues. It never says a site passes.
license: MIT for code, CC BY 4.0 for prose. See LICENSE in github.com/AhoyLemon/skills.
compatibility: Claude Code or Codex, with Node 22.18 or later, git, the GitHub CLI signed in, and Chrome or Edge installed (or Playwright's own Chromium).
metadata:
  author: Lemon
  version: 1.1.0
allowed-tools: Read(${CLAUDE_SKILL_DIR}/**) Bash(node ${CLAUDE_SKILL_DIR}/runner.ts *)
---

# actua11y

The "well, actually" to "we're basically done with accessibility".

**A machine can prove a fail, and it can never prove a pass.** Everything here follows from that. Nothing you write in this skill, in an issue, a comment, a PR or a summary, ever says the target "passes", "complies" or "conforms".

**Say this first, every run, in your own words or these:** actua11y is Lemon's best-faith effort, and it guarantees nothing. It's a floor, not a certificate. The runner prints the same line, and everything it posts carries it.

## The four verdicts

Every WCAG criterion at the target gets exactly one. The runner computes it from the finder's findings, so no model ever writes a verdict.

| Verdict | Means | Owes you |
|---|---|---|
| ✅ | A machine found no fail, by doing something specific | The evidence, so anyone can challenge it |
| ❌ | A machine proved a fail | `file:line`, who it hurts, and exact repro steps when it's behaviour |
| 🕵️ | A machine can't settle it | What a person should check, and how |
| n/a | The criterion doesn't apply | A one-line reason |

There is no fourth state. Anything measured and then left undecided is a 🕵️ with its own line. Once the loop runs, ✅ on a fail means "certifier pass N found no fail at `<sha>`, by doing this", never "passes".

## How it runs

You, in the user's own session, are the orchestrator: you do the intake, call the runner, start the fixer, and report. Two fresh, isolated, read-only sessions do the judging: the finder, and later the certifier, both blind to this conversation. The runner starts them, validates every report, and does every GitHub write. You never file, render, post or paraphrase findings yourself.

The runner lives in this skill's base directory. Call it as `node <base directory>/runner.ts <command>`, from inside the repository being audited. Run `node --version` first: it needs 22.18 or later. `node <base>/runner.ts --help` lists every command.

In Codex, pass `--backend codex` to preflight, dry-run, brief finder, run finder, brief certifier and run certifier; Claude Code is the default. The runner must be able to start Chrome and create a child sandbox, so run it outside any enclosing sandbox when necessary. See [Codex's isolation and limits](references/codex.md) before starting.

The record lives on GitHub: the two issues and the PR. Nothing you need to carry on is kept anywhere else, so a loop can pick up days later in a fresh session. When you're unsure where things stand, run `node <base>/runner.ts status --issue <agent issue number>`. It rebuilds the state from GitHub alone and prints the next command.

### 0. Intake

Ask these together where you can, and keep it brisk.

- **The target level: A, AA or AAA.** Levels are cumulative (AA means A and AA). If the project names a standard (a contract, an accessibility statement, the README), offer that. Otherwise ask, with all three as real options.
- **At AAA, warn before anything runs**, something like: "AAA it is. I'll do my best, but this is a best effort, not a claim. Meeting AAA for real needs a qualified accessibility specialist and testing with disabled people, and WCAG itself doesn't recommend AAA as a blanket target for a whole site." The runner and everything it posts repeat it.
- **The scope.** What the user names, or a stated assumption they can correct in a word ("the whole site", "these pages", "this branch's changes"). Pass paths with `--scope`, and pages with `--page` if they named them. Otherwise the finder finds the pages itself.
- **The running site.** A URL for a dev server that's already up (`--url`), or a folder for a static site, which the runner serves on localhost for each run (`--serve <folder>`). If the site needs a dev server and none is running, ask before starting one. A dev server has to serve this checkout, since the certifier later judges whatever it serves.
- **Why a real browser.** Say it plainly: the finder and the certifier drive the user's installed Chrome or Edge, headless, because keyboard behaviour, focus and rendered contrast only exist once a page is running. Some people don't want that by default, so they should hear why.
- **Assess-only, or the full loop.** Assess-only files the two issues and stops. The loop goes on to fix every ❌, certify each fix blind, hand the rest to a person, and close both issues with one PR. Either is a real option, and an assess-only run can become a loop later.
- **Filing.** Say where it will file: two issues on this repository's GitHub, one for agents and one for a person, assigned to them. For the loop, also a branch and a draft PR, which stays a draft until close-out. Get their OK before the first real run.
- **The model.** Its own question, never bundled with anything else: which model the finder and the certifier run on, with the default from `--help` as the recommended answer and a cheaper one as the alternative. Pass `--model` (and `--effort`, if they want a different one) to every command that starts a session.
- **The loop's budget.** For Claude Code, ask the most the runner may spend across the whole loop (dry runs, the finder, every certifier pass), with $60 as the recommended answer. Pass it as `--budget-usd` to `loop start`. Codex reports tokens, not dollars, so its dollar cost is not measured and a dollar budget cannot limit its runs. The fixer runs as a subagent in this session, with tokens and minutes reported by that session.
- **The per-session caps,** in a line, not a question: Claude Code stops at 300 turns, $20 or 60 minutes, shared across correction rounds. Codex has only the 60-minute wall-clock cap; tokens are reported but its dollar spend is not measured. Pass `--timeout-minutes` or, for Claude Code, `--max-turns` and `--max-budget-usd` only if the user asks for different.

### 1. Preflight

`node <base>/runner.ts preflight --level <L> [--scope ...] (--url <url> | --serve <folder>)`

It refuses on any ✗ and prints a fix for each:

- the working tree must be clean and level with its remote
- no gitignored strays (a `node_modules`, a stray `package.json`) inside the scope
- `gh` must be signed in, with issues on
- Node must be 22.18 or later
- a browser must actually launch
- the site must answer

Relay each ✗ and its fix, and don't start until it's clean. If a gitignored path genuinely belongs inside the scope, ask, then pass `--allow-ignored <path>`. The finder is barred from reading it. Do the same for a cache folder the site's dev server writes into the repository while it runs (`.next`, `.vite`, `.cache`), even if it doesn't exist yet. A `!` line is a warning to mention, not a blocker.

### 2. Dry run

`node <base>/runner.ts dry-run` (with the same `--model` and `--effort` the session will use)

Before the first real run in a session, this starts a fresh session with no tools, isolated exactly like the finder and the certifier, and asks it what it loaded. The runner checks the mechanical part itself. Then you read its answer. It should name no instruction files, memory, skills, plugins, MCP servers or hooks, and know nothing about the repository beyond its path (it will know the signed-in account, which is expected). If it names anything else, stop and show the user. A finder or certifier run refuses to start without a clean dry run from the last six hours, so a human round days later needs a new one.

### 3. The finder

`node <base>/runner.ts run finder --level <L> [--scope ...] (--url <url> | --serve <folder>) [--page ...] [--allow-ignored ...]`

This takes a while. Run it in the background if you can, and tell the user roughly how long and what it costs. When it finishes, relay the tally, the cost and the run id. If it says the finder changed the repository, stop and show the user before anything else. If it couldn't get a usable report, say so plainly, with the path it printed.

### 4. File

`node <base>/runner.ts file --run <run-id>`

This files both issues, cross-links them and attaches the raw report. `--preview` writes the bodies locally instead, if the user wants to see them first. If filing stops partway, run the same command again, and it picks up where it stopped.

It refuses a run that changed tracked or untracked files, and there's no way past that: the finder must never write to the app. If it says tool calls named paths the finder must never read, show the user those lines and the transcript path before filing, and file only with their OK. If only new gitignored paths appeared, show them to the user. If they confirm each one came from their own dev server, pass `--allow-ignored <path>` for each to `file`.

**Assess-only stops here.** Tell the user where each issue is, how many fails went to agents and how many checks to them, what it cost, and that the person's issue is the part only they can do.

### 5. Start the loop

`node <base>/runner.ts loop start --issue <agent issue number> [--branch <name>] [--budget-usd 60]`

It cuts a branch from the audited commit and pushes it. If the project has a branch-naming convention, pass a name in its style. The draft PR opens when the first commit lands, since GitHub won't open a PR with no commits.

### 6. The fixer

1. `node <base>/runner.ts brief fixer --issue <n>` prints the fixer's brief: every open ❌, frozen for this round, ending in a brief id.
2. Start a fresh subagent and have it run that command itself and follow the brief it prints, so the brief reaches it **whole and unchanged**. (Pasting the output in as its prompt works too, but a long brief is easy to clip by accident.) Never paraphrase it, trim it or add to it, and tell it nothing else about the work beyond where its report goes. The fixer edits and commits in this checkout, under the project's own conventions, and goes after every ❌, one commit per finding.
3. Pass its final message to the runner unchanged, on stdin, with the tokens and minutes its result reported. The usage can arrive a moment after the report itself, so wait for it:

   ```bash
   node <base>/runner.ts record fixer --issue <n> --tokens <t> --minutes <m> <<'ACTUA11Y_REPORT'
   <the subagent's final message, exactly as it came back>
   ACTUA11Y_REPORT
   ```

If the runner lists problems, send them back to the same subagent if you can, and record its whole corrected report again. When it's accepted, the runner pushes, opens the draft PR if needed, posts the fixer's report on it, and marks each item "claimed at `<sha>`". Only a certifier ever makes one ✅.

### 7. The certifier

`node <base>/runner.ts run certifier --issue <n> [--url <url> | --serve <folder>]`, then `node <base>/runner.ts file --run <run-id>`

A fresh, read-only session isolated exactly like the finder, checking the branch's head. It gets the list of what was wrong and never anyone's account of the fixes: no PR, no issues, no commit messages, no git history. It judges every item, runs every carried repro again word for word, then re-walks the whole target. The runner computes the verdict from its report. It takes a while, so run it in the background if you can. `file` posts it on the PR and updates both issues, with the same refusals as filing the finder.

Then `status` says what's next. Not approved means back to step 6 with what still fails. The cap is 3 fixer rounds, or the budget running out: at the cap, every open ❌ moves to the person's issue with its repro steps, and you say so plainly. `loop stop` ends the AI rounds early, the same way, if the user wants.

### 8. Report back

When the AI rounds end, approved or at the cap, the runner posts a report back on the PR, with a cost table of every run so far. The record is there, so keep the session short. In two or three lines, say what the AI did alone and what it cost, then relay the runner's **"Your turn" block** as it stands, add a URL to test, and stop. For a static site, `node <base>/runner.ts serve --serve <folder>` serves it on localhost until they stop it. Don't restate the checklist or explain the rest of the loop unless they ask.

### 9. The human round

The human round is the person and the fixer working together, with a blind certifier guarding every fix. The person works their own issue, with real devices, a screen reader and their own thumbs. For each 🕵️ check:

- **If it holds up,** they tick it. Only they tick checks, never you and never a certifier. If they ask you to tick for them, push back: the tick is their word that they checked it, and an edit through `gh` would show as theirs. Leave the choice with them.
- **If it doesn't,** they leave it unticked and comment on their issue with what's wrong and how they want it solved. You record that as a finding that settles the check.

They also comment with anything else they find by using it, and decide each ❌ moved to them: fix it, accept it as it is (with a reason), or not applicable (with a reason).

**Their words go on the issue, and chat is for saying they're done.** Every time it's their turn, the runner prints a "Your turn" block: relay it as it stands and stop. If they answer in chat anyway, say in one line that it goes on their issue, since the runner records only words it finds there. Offer their own text back, ready to paste, only if they ask.

Record each one with the runner, in their words, which it checks against their issue word for word:

- `node <base>/runner.ts record finding --issue <n> --words "<their words>" (--criterion <num> | --ux) [--check <P4>] --decision fix|accept|na [--how "<their words>" | --reason "<their words>"]`
- `node <base>/runner.ts record decision --issue <n> --item <A7 or H2> --decision fix|accept|na [--how "<their words>" | --reason "<their words>"]`

Before you record a finding, check it against the code. If it would undo a fix the loop already made, or the code already does it another way for a good reason (a `role="status"` they want swapped for `role="alert"`, say), tell them what you found and ask once. They decide. Ask whether each finding is a WCAG criterion (which one) or a UX problem. The runner works out the level, and whether it's inside the target, from the table. Findings outside the target, and UX findings, are recorded and fixed if they want, and never hold up close-out. When the runner says so after recording one, tell them in a line: happy to, but it isn't a WCAG fix and doesn't count toward the audit. `--check` links a finding to the check it came from. `--how` is how they want it solved, for a fix, and `--reason` is why, for accept or n/a. The runner wants at least three of their words for each, matched whole, so a fragment can't stand in for what they meant. If any of their words aren't in their issue yet, ask them to write them there. Don't type them in for them.

Then the fixes:

1. `brief fixer` again (step 6). In the human round its list is the person's fix decisions, in their words, with how they want each one solved. Hand it to a subagent and record it exactly as in step 6. The person is right there, so they can watch it work. If it heads the wrong way, they change their words in their issue and you brief it again, rather than steering it in chat, so the record says who decided what.
2. Or the person fixes something by hand (or has you do it) and pushes. A fixer briefed afterwards starts from their commits, so it never has to account for them.
3. Then run the certifier again (step 7). It gets the person's decisions and how-to in their words, guards the fixes and hunts for regressions. Not approved means back to the fixer. The cap is 3 certifier passes in the human round.

### 10. Close-out

`node <base>/runner.ts close-out --issue <n>`

It refuses until the latest pass approved, every check is ticked or turned into a finding, and every finding and moved fail is decided. If commits landed after the certified commit, it stops: run the certifier again (best), or pass `--uncertified-ok` to list them as uncertified. At the human round's cap, `--at-cap` closes out anyway and says so plainly. Then it writes the final summary into the PR body with the closing lines last, takes the PR out of draft, and prints a merge command pinned to the certified commit. Suggest that command to the user. **The merge is theirs.**

## Never

- Say or imply the site passes, complies or conforms, anywhere.
- Paraphrase, summarise or re-rank any role's findings as if they were yours. The issues and the PR are the record.
- File, edit, comment, open or merge anything on GitHub by hand. The runner does every write, and the merge is the person's.
- Change the fixer's brief, or its report, on the way through. Both go whole and unchanged.
- Tell the certifier anything, or start it yourself. The runner builds its brief.
- Record words as the person's that aren't in their issue, or tick a check for them.
- Edit a run's local record, or the ledger in the agent issue. The fix for a bad report is another run.
- Edit the repository yourself during the AI rounds. Fixes come from the fixer then, and in the human round from the fixer or from the person (or you, when they ask you to).
- Fake independence. If the runner can't start an isolated session here, say so and stop.

## Files

- `runner.ts`: the commands above. Everything agent-neutral lives behind it.
- `briefs/finder.md`, `briefs/fixer.md`, `briefs/certifier.md`, `briefs/dry-run.md`: what each session is told, filled in by the runner.
- `data/wcag22.json`: the WCAG 2.2 criteria, levels, titles and their exceptions and notes, generated from W3C's data. Levels come from here, never from memory.
- `kit/`: the browser scripts each run installs into its own scratch folder.
- `references/claude-code.md`: how isolation works in Claude Code, why the fixer is a subagent, and the known limits.
- `CHANGELOG.md`
