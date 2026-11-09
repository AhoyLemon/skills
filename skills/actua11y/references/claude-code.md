# actua11y in Claude Code

How the Claude Code backend (`_backends/_claude-code.ts`) starts a fresh, isolated session, why each piece is there, and what it still can't promise. Every mechanism here worked in practice, but re-check the flags against Claude Code's own docs whenever you change them. The backend records the version they were last verified against (`VERIFIED_VERSION`, currently 2.1.319), and the preflight warns on anything older.

## How a session starts

`claude -p` (headless), with the brief on stdin, never in argv, and output as `stream-json` (which needs `--verbose`). Then, layer by layer:

| Layer | What the backend does | Why |
|---|---|---|
| Environment | Starts from an emptied environment plus `HOME PATH USER LOGNAME SHELL TERM LANG TMPDIR` | A shell inside an agent session carries dozens of variables (effort level, entrypoint, a child-session flag). A run started from one inherited them all until this |
| Settings | `--setting-sources ""` | Loads none of the user, project or local settings files. Safe mode alone still loaded the user's `~/.claude/settings.json`, which once added an extra working directory. Verified: a project settings file that denies a tool has no effect under `""`, and does under `project` |
| Instructions, skills, plugins, hooks, MCP | `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, plus `disableAllHooks` and the built-in AGENTS.md plugin switched off in `--settings` | No CLAUDE.md, AGENTS.md, memory, skills, plugins, hooks or MCP servers reach the finder. Verified with canary lines in both instruction files |
| Memory | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `autoMemoryEnabled: false` | A session in the same project folder could otherwise load memories about the work, or write some |
| Git context | `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` and `includeGitInstructions: false` | Git instructions put a status snapshot, recent commit messages included, into context |
| Permissions | `--permission-mode dontAsk` and `--permission-prompts none` | Anything not allowed is denied, and nobody is there to approve it |
| Tools | The finder gets `Read Glob Grep Bash Write Edit`, with edits allowed only under its scratch folder. The dry run gets none (`--tools ""`) | Read-only by rule, with a place to write its own browser scripts |
| Deny rules | All git, all gh, installs, web search and fetch, subagents, edits in the repository, and reads of every off-limits path | Words in a brief are a request, and rules make it a requirement |
| Model and effort | `--model` and `--effort` pinned per role, and recorded on every issue | Effort once leaked in through the environment |
| Caps | `--max-turns`, `--max-budget-usd`, and a wall-clock timeout that kills the process | A stuck session can't run up a bill |

**Off-limits paths are worked out from disk**, not typed by hand:

- the repository's `.git`, and its gitignored entries
- every sibling of the repository's folder
- actua11y's own run records
- any other `actua11y-*` scratch folder
- credential and agent folders in your home directory (`.claude`, `.agents`, `.codex`, `.config/gh`, `.ssh`, `.aws` and the like)

The brief lists the same paths, generated from the same list.

**Every session's first event is checked.** The init event names the model, tools, MCP servers, skills and plugins the session actually loaded. If anything is unexpected (an MCP server, a skill, a non-built-in plugin, a tool it shouldn't have, the wrong model or permission mode), the backend kills the session on the spot.

**Every result event counts.** A session can wake for more turns after its job, and each wake ends in a result of its own. The runner reads them all, takes the report from the last one that holds a valid report, and takes cost from each process's last result. A resumed session reports its own cost, so a correction round adds to the total.

## The dry run

`runner.ts dry-run` starts a session isolated exactly like the finder, with no tools, and asks it to name every instruction file, memory, skill, plugin, MCP server and hook it loaded, and what it knows about the repository. The runner checks the init event mechanically, and the orchestrator reads the answer. In practice a clean one costs about a cent on Sonnet and a few cents on Opus. A finder run refuses to start without a clean dry run for the same repository and model from the last six hours.

## What it can't promise

- **The session knows who's signed in.** Claude Code tells it the account's email. That's the login, not the project, and there's no way around it without an API key.
- **Paths carry meaning.** A repository called `smoke` or `test` tells the finder something. Name things like a real project when you want a blind run.
- **Deny rules don't sandbox a shell.** A determined script could still read or write past them. The rules stop habits and accidents, and the runner catches what slips through. It snapshots `git status --ignored`, HEAD and the branch before and after every run, and refuses to file a run that changed anything.
- **One engine.** The finder drives Chromium (branded Chrome or Edge). Behaviour in WebKit and Firefox is always a person's check.
- **Built-in plugins still load.** Claude Code's own built-ins (security, privacy, telemetry) appear even in safe mode. The backend allows those, minus the AGENTS.md one, and stops a session on anything else.

## Run records

Each run keeps a local record in `~/.local/state/actua11y/runs/<owner>__<repo>/<run-id>/` (or under `$XDG_STATE_HOME`):

- `meta.json`
- the filled `brief.md`
- `transcript.jsonl`
- `report.json`
- `filed.json`

Transcripts stay local because they're large and can hold secrets. The issues record where they are.
