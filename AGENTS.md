# Working in AhoyLemon/skills

Guidance for every agent (and person) working here. `CLAUDE.md` just imports this file, so keep shared guidance here and nowhere else.

## What this repo is

A public collection of agentic skills by Lemon, installed with the vercel-labs skills CLI (`npx skills add ahoylemon/skills`). Everything here is Lemon's best-faith effort and guarantees nothing. Say so wherever a skill reports to someone.

## Built for AI, openly

These skills are built for AI, so they don't hide that AI builds them.

- Commits an agent makes carry a `Co-Authored-By` trailer naming the agent and model.
- Issues, PRs and comments an agent writes name the agent and the model at the end, for example "Claude Code, Claude Opus 5.5 (`claude-opus-5-5`)".

## Public and self-contained

- Nothing in this repo links to or depends on a private repo. CI checks every GitHub repo link and fails on one it can't see (`bun run check:links`).
- No company's name, branding or ownership appears anywhere in this repo. CI doesn't check this (a public check would have to spell out what it looks for), so it's on you.
- Lessons learned elsewhere get restated here in this repo's own words, never linked.

## Layout

```
skills/<name>/       one folder per skill, and the only thing the skills CLI installs
scripts/             dev scripts (never shipped)
tests/               node --test suites and synthetic fixtures (never shipped)
.github/workflows/   CI
```

- **No `SKILL.md` at the repo root.** The skills CLI treats a root one as the only skill and stops looking under `skills/`.
- **The CLI copies a skill's whole folder**, so keep tests, fixtures and dev scripts outside `skills/`.
- **Never name a file `metadata.json` inside a skill.** The CLI silently skips that filename.
- A skill's folder name equals its `name` in `SKILL.md`. Put extra frontmatter (author, version) under `metadata:` so the skill stays portable.

## Code

- TypeScript that plain `node` runs: Node 22.18+ strips types, so there's no build step. That means erasable syntax only (no `enum`, no namespaces, no parameter properties), `.ts` extensions on relative imports, and `import type` for types.
- A skill's runtime code has **zero dependencies**. A skill can't count on an install step. Anything heavier (actua11y's browser kit) is installed per run into a scratch folder, never into the skill or the user's project.
- Files made to be imported take a `_` prefix (`_report.ts`). Entry points and scripts don't.
- Non-trivial object shapes (roughly three or more properties) get a named `interface` or `type`.
- No `any`, and no `console.log` left in. User-facing output goes through the skill's own output helper.
- Aim for files of 900 lines or fewer, splitting into importable pieces when one grows past that.
- Comments are one line each. No hard wrapping, in code or in Markdown.

## Markdown

One line per paragraph. Line breaks are for structure only: lists, tables, code blocks and headings.

## Git and GitHub

- Work against an issue. Branches are `type_NN--brief-slug` (`issue`, `feature`, `bug` or `chore`), for example `issue_1--actua11y-assess-only`. With no issue, use a date: `chore_20261109--bump-deps`.
- Commit titles start with the issue number: `#1 Add the WCAG criteria table`.
- PR descriptions open with `This closes #N`, one per line for several issues, then explain why. The diff already says what.
- A change to behaviour updates the docs that describe it (the skill's `SKILL.md`, its references, its `CHANGELOG.md`, the README) in the same PR.

## Checks

```bash
bun install
```

```bash
bun run typecheck
```

```bash
bun run test
```

```bash
bun run check:links
```

CI runs all three on every PR, on Node 22.18.0 and the current LTS.

One test drives a real browser through actua11y's kit. It skips on a machine with no Chrome, Edge or Playwright Chromium, and fails in CI, where Chrome is always installed.

## Licenses

Code is MIT (`LICENSE-MIT`). Prose is CC BY 4.0 (`LICENSE-CC-BY-4.0`). `LICENSE` says which covers what. New files follow the same split.

## actua11y

- **A machine can prove a fail, and it can never prove a pass.** Nothing actua11y writes, in an issue, a comment, a PR or a summary, ever says the target "passes". The renderer's tests guard this, so keep them green.
- Agent-specific code lives only in `skills/actua11y/_backends/` and agent-specific prose only in `skills/actua11y/references/`. Everything else stays agent-neutral, so another backend can slot in.
- The WCAG table is generated from W3C's data by `bun run build:criteria`. Never edit `data/wcag22.json` by hand, and never let a model supply a criterion's level.
