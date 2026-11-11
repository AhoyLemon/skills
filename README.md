# skills

Agentic skills made by Lemon. They're built for AI, and built with it, and they say so.

## What's here

| Skill | What it does |
|---|---|
| [actua11y](skills/actua11y/) | An accessibility audit and fix loop for coding agents that's honest about the line between what a machine settled and what still needs a person. It assesses a site against WCAG 2.2 and files two GitHub issues, one for agents and one for you. Then, if you want, it fixes every proven fail, has a blind certifier check each fix, hands the rest to you to work through with the fixer while a certifier guards every fix, and closes both issues with one PR. |

## Install

```bash
npx skills add ahoylemon/skills
```

That's the whole line. With one skill in here, the CLI picks it for you. Once there are more, it offers a menu, or you can name one:

```bash
npx skills add ahoylemon/skills --skill actua11y -g
```

The `-g` installs it for every project instead of the one you're standing in. actua11y wants a clean working tree before it runs, so a global install keeps it out of the project you're auditing. The skills CLI needs Node 22.20 or later.

## Best faith, no guarantees

Everything here is Lemon's best-faith effort, and none of it guarantees anything. actua11y especially: a machine can prove a fail, and it can never prove a pass, so it will never tell you your site passes. It will tell you exactly which parts a person still has to check.

## Licenses

Code is MIT and prose is CC BY 4.0. [LICENSE](LICENSE) says which covers what, and credits W3C for the WCAG data.

## Working on it

People and agents both start with [AGENTS.md](AGENTS.md).
