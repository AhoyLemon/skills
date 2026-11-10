# Changelog

## 0.1.0 (unreleased)

The assess-only slice.

- Intake, a preflight that refuses to start on a dirty tree, a stray, a missing browser or a signed-out `gh`, and a dry run that proves a fresh session loads nothing beyond its brief.
- The finder: a fresh, read-only Claude Code session that gives every WCAG 2.2 criterion at the target exactly one verdict, with levels from a table generated from W3C's data.
- A browser kit (playwright-core and axe-core) installed per run into a scratch folder, driving the installed Chrome or Edge (or Playwright's own Chromium when neither is there), with a scan script that runs axe at the level's tags.
- A structured report the runner validates, with verdicts computed from the findings, never written by a model.
- Filing that survives a partial failure (rerun and it picks up where it stopped), moves any list too long for GitHub into comments, and refuses a report that changed after the run.
- Filing: one issue for agents (every ❌, with `file:line`, who it hurts and repro steps, plus the ✅ evidence collapsed) and one for a person (every 🕵️), cross-linked, with the raw report attached.
