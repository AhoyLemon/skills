# Your job: fix every ❌ on this list

You're fixing accessibility problems in this repository, {{REPO_ROOT}}, on the branch `{{BRANCH}}`, against WCAG 2.2 {{LEVEL_LABEL}}. {{INTRO}} Afterwards a separate, blind certifier checks your work. It never sees this brief, your report or your commit messages, only the code at the commit you leave.

{{ROUND_LINE}} This round starts at commit `{{BASE}}`, and the runner checks every commit you make after it.

## How to fix

- **Every ❌, not a top three.** An earlier run told a fixer to fix only the top three and the easy wins. It left six problems that a person later hit by hand, all of them already on the list. If you can't fix one, say so in your report. That's an answer, not a failure.
- **Fix for people, not for a checker.** The goal is that the person who's hurt can now do the thing. Quieting axe isn't the goal.
- **Where a person said how they want it solved, solve it their way.** If their way can't work, say so in your report rather than quietly doing something else.
- **Prefer native HTML to ARIA.** A clickable `div` becomes a `button`, not a `div` with a role. Reach for ARIA only where no native element does the job.
- **One commit per finding**, in this project's own commit style. If one change genuinely fixes two findings, commit it once and cite that commit for both.
- **Follow the project's own conventions** for code, markup and styles.
- **Leave no trace of this audit in the code.** No comments, files or notes that mention actua11y, a finding's id or this list. The certifier reads the code.
- **Don't push, and don't touch GitHub.** No `gh`, no issues, no PR. The runner pushes and posts. Don't rebase, amend or squash anything either.
- **Work from this list only.** It was frozen for this round. Don't read the issues or the PR, which may have moved on since.
- **Leave the working tree clean:** everything committed, nothing stray.

## The list ({{COUNT}})

{{ITEMS}}

## Your report

When you're done, your final message is your report: one JSON object in a single ```json block, with nothing after it. The session that started you passes it to the runner unchanged, and the runner checks it against the branch.

```ts
{{REPORT_SCHEMA}}
```

- Every finding gets exactly one outcome. **Partial and couldnt are real answers, and they're required when they're true.** An earlier fixer admitted a half fix only in its own transcript, and its PR description didn't. Say what's left, or why not.
- {{NEEDS_PERSON}}
- Cite every commit you made in the finding it belongs to. The runner refuses a commit nothing cites.
- Words you don't use anywhere in the report: any form of pass, comply, conform or certify.
