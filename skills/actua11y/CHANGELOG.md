# Changelog

## 1.0.0 (2026-11-12)

The fix-and-certify loop, after the assess-only slice. Assess-only stays an option at intake.

- A loop that resumes from GitHub alone. Its state, the ledger, rides in the agent issue's body, every raw report rides in a comment, and `status` rebuilds where things stand and prints the next command. Nothing local is needed to carry on.
- The fixer, a subagent in the user's own session, handed the runner's brief unchanged (a brief id proves it). It goes after every ❌, one commit per finding, and its report requires fixed, partial or couldn't for each, every commit accounted for. The runner pushes, opens a draft PR, posts the report, and marks each item claimed.
- The certifier, isolated exactly like the finder, so one dry run proves both. It never sees the PR, the issues, commit messages, git history or the fixer's report. It judges every item, runs every carried repro again word for word, re-walks the whole target, and the runner computes its verdict.
- A cap of 3 fixer rounds plus a budget for everything the runner starts. At the cap every open ❌ moves to the person's issue with its repro steps, and the loop says so.
- The human round, the person and the fixer together: the person ticks each check that holds up, and turns each one that doesn't into a finding, with how they want it solved, in a comment on their issue (or in their own region of it, which every re-render keeps byte for byte). Their checklist runs by level (A, AA, AAA, then UX), then by labels the finder and certifier choose for the site, such as a page or a tool, so they can test one place at a time. Whenever it's their turn, the runner prints a short "Your turn" block for the session to relay: their issue, what's left, and that their words go on the issue, not in chat. Each finding is tagged WCAG (level and inside or outside the target, worked out from the table) or UX, and gets a decision, recorded only if their words are in their issue. The fixer works their fix decisions in their words, or they fix things by hand first, and a blind certifier, given their how-to, guards it all and never closes a 🕵️.
- Close-out names the certified commit, refuses or lists anything that landed after it, puts the closing lines last, takes the PR out of draft and suggests a merge pinned to that commit. The merge stays the person's.
- The same cost table on every issue and comment the runner posts: each run's model, start and end in the filing machine's time zone, tokens, spend and the budget left. The report back and close-out list every run with a total. Intake asks the model and the loop's budget as questions of their own.
- `serve`, for a URL to test a static site, and a log of every path the runner's own server sent, shown beside the pages each role says it loaded.

## 0.1.0

The assess-only slice.

- Intake, a preflight that refuses to start on a dirty tree, a stray, a missing browser or a signed-out `gh`, and a dry run that proves a fresh session loads nothing beyond its brief.
- The finder: a fresh, read-only Claude Code session that gives every WCAG 2.2 criterion at the target exactly one verdict, with levels, titles and each criterion's exceptions and notes from a table generated from W3C's data.
- A browser kit (playwright-core and axe-core) installed per run into a scratch folder, driving the installed Chrome or Edge (or Playwright's own Chromium when neither is there), with a scan script that runs axe at the level's tags.
- A structured report the runner validates, with verdicts computed from the findings, never written by a model.
- Filing that survives a partial failure (rerun and it picks up where it stopped), moves any list too long for GitHub into comments, and refuses a report that changed after the run.
- Filing: one issue for agents (every ❌, with `file:line`, who it hurts and repro steps, plus the ✅ evidence collapsed) and one for a person (every 🕵️), cross-linked, with the raw report attached.
