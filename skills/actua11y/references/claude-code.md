# actua11y in Claude Code

How the Claude Code backend (`_backends/_claude-code.ts`) starts a fresh, isolated session, why each piece is there, and what it still can't promise. Every mechanism here worked in practice, but re-check the flags against Claude Code's own docs whenever you change them. The backend records the version they were last verified against (`VERIFIED_VERSION`, currently 2.1.319), and the preflight warns on anything older.

## How a session starts

`claude -p` (headless), with the brief on stdin, never in argv, and output as `stream-json` (which needs `--verbose`). Then, layer by layer:

| Layer | What the backend does | Why |
|---|---|---|
| Environment | Starts from an emptied environment plus `HOME PATH USER LOGNAME SHELL TERM LANG TMPDIR`, and passes through only sign-in and network variables (API key, OAuth token, Bedrock, Vertex, AWS, proxy, extra CA certificates) | A shell inside an agent session carries dozens of variables (effort level, entrypoint, a child-session flag). A run started from one inherited them all until this. Sign-in and network settings change how the session reaches the model, not what it knows or may do |
| Settings | `--setting-sources ""` | Loads none of the user, project or local settings files. Safe mode alone still loaded the user's `~/.claude/settings.json`, which once added an extra working directory. Verified: a project settings file that denies a tool has no effect under `""`, and does under `project` |
| Instructions, skills, plugins, hooks, MCP | `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, plus `disableAllHooks` and the built-in AGENTS.md plugin switched off in `--settings` | No CLAUDE.md, AGENTS.md, memory, skills, plugins, hooks or MCP servers reach the finder. Verified with canary lines in both instruction files |
| Memory | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `autoMemoryEnabled: false` | A session in the same project folder could otherwise load memories about the work, or write some |
| Git context | `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` and `includeGitInstructions: false` | Git instructions put a status snapshot, recent commit messages included, into context |
| Permissions | `--permission-mode dontAsk` and `--permission-prompts none` | Anything not allowed is denied, and nobody is there to approve it |
| Tools | The finder gets `Read Glob Grep Bash Write Edit`. Reads are allowed only under the repository, its scratch folder and its own task folder, and edits only under its scratch folder. There's no bare `Read`, `Glob` or `Grep` rule, because Read rules govern all three, so anything else is refused and counted. The dry run gets no tools (`--tools ""`) | Read-only by rule, with a place to write its own browser scripts. Verified: with scoped Read rules, Read, Glob and Grep on a file outside are each refused, and still work inside the repository. With a bare Glob or Grep kept, those two read anywhere |
| Deny rules | All git, all gh, installs, web search and fetch, subagents, edits in the repository, and reads of every off-limits path | Words in a brief are a request, and rules make it a requirement |
| Model and effort | `--model` and `--effort` pinned per role (by default `claude-opus-5-5` at `high`), and recorded on every issue | Effort once leaked in through the environment |
| Caps | `--max-turns`, `--max-budget-usd`, and a wall-clock timeout that kills the process. A correction round gets only what's left of all three, and the session is killed if the runner is stopped | A stuck session can't run up a bill |

**Off-limits paths are worked out from disk**, not typed by hand:

- the repository's `.git`, and its gitignored entries
- every sibling of the repository's folder, except one that holds the run's own scratch folder
- actua11y's own run records
- any other `actua11y-*` scratch folder
- credential and agent folders in your home directory (`.claude`, `.agents`, `.codex`, `.config/gh`, `.ssh`, `.aws` and the like), plus `~/.claude.json`, which lists the path of every project you've opened in Claude Code
- Claude Code's own temp folder, `/tmp/claude-<uid>/`, which holds every session's scratch files and task output: every other project's folder, and the sessions already in this project's folder (the orchestrating session's among them), but not the folder the finder's own session is about to be created in
- where a barred folder holds the repository or the scratch folder (an app cloned into an agent's temp folder, say), everything in it except the way down to them

The brief states the rule in general terms (nothing outside the repository and the scratch folder, nothing in `.git` or gitignored), generated from the same spec the backend enforces. It deliberately doesn't list the paths, which would hand the session the names of your other projects.

**Every session's first event is checked.** The init event names the model, tools, MCP servers, skills and plugins the session actually loaded. If anything is unexpected (an MCP server, a skill, a non-built-in plugin, a tool it shouldn't have, the wrong model or permission mode), the backend kills the session on the spot, and nothing it reported is ever filed. A session that never sends one is judged the same way once it ends: no retry, and nothing filed.

**Denied tool calls are counted, and every tool call is checked.** When the finder tries something its rules deny, the run's summary says how many times and points at the transcript. Bash isn't fenced by the read rules, so after the run every tool call's input is also checked against the off-limits list: the exact path, without macOS's `/private` prefix, from home as `~`, or relative from the repository (`../answers`). A name only counts at a path boundary, and paths inside the repository (`.git`, `node_modules`) only in full, since a finder rightly names them to exclude them. Any hit is listed in the summary, and both issues say what the fences caught.

**Every result event counts.** A session can wake for more turns after its job, and each wake ends in a result of its own. The runner reads them all, takes the report from the last one that holds a valid report, and takes cost from each process's last result. A resumed session reports its own cost, so a correction round adds to the total.

## The dry run

`runner.ts dry-run` starts a session isolated exactly like the finder, with no tools, and asks it to name every instruction file, memory, skill, plugin, MCP server and hook it loaded, and what it knows about the repository. The runner checks the init event mechanically, and the orchestrator reads the answer. In practice a clean one costs about a cent on Sonnet and a few cents on Opus. A finder or certifier run refuses to start without a clean dry run for the same repository, backend, model and effort from the last six hours.

The dry run also says how the session reaches the model: your Claude sign-in, or an API key it will bill. `ANTHROPIC_API_KEY` passes through to the finder just as it would to `claude -p` in your own shell, so if it's set, the run bills that API account. The dry run names it so it's never a surprise.

The dry run is also where an expired sign-in shows up. The runner starts sessions with the `claude` command's own login, which lapses on its own schedule, apart from whatever session is running intake. The dry run then fails at no cost with `api_error: Failed to authenticate`. Ask the user to run `claude auth login` (or `claude setup-token` for a long-lived token), then run the dry run again. Never sign in for them.

## The certifier

The certifier starts exactly like the finder: the same flags, the same environment, the same tools, deny rules and off-limits list, worked out from disk the same way. Only the brief differs, and a test pins that, so one clean dry run for a model and effort proves what both load.

Its blindness rests on those rules, not on its brief alone:

- **No PR, no issues.** All of `gh`, and web search and fetch, are denied, so it can't read the PR's description or comments, the fixer's report, or the issues as they stand now.
- **No history, no commit messages.** All of `git` is denied, and the repository's `.git` folder is off-limits to Read, Glob and Grep. The runner switches to the loop's branch itself (only on a clean tree) and checks that HEAD matches the PR's head before the certifier starts, so it reads exactly the commit it judges.
- **No edits.** Edits in the repository are denied, as for the finder, and the runner refuses to file a pass that changed a tracked or untracked file.
- **Nothing the fixer left behind.** The fixer's report reaches the runner on stdin and lives only in the run records and on the PR, both off-limits. The orchestrating session's own temp folder, where its subagents' output can sit, is off-limits too, as is `~/.claude`, which holds every session's transcripts.

Its brief is built by the runner from the ledger: the finder's account of each fail (never a status, a claim or the fixer's words), every carried repro, the person's "fix" decisions in their own words during a human round, and what's known and out of scope.

## The fixer

The fixer runs as a subagent in the user's own session (Claude Code's Agent tool), not headless. It's meant to edit, it wants the project's own conventions (its CLAUDE.md, its style), and its honesty comes from the report's required fields (fixed, partial or couldn't, each owing what it owes, every commit accounted for), not from isolation.

The orchestrator has the subagent run `brief fixer` itself and follow what it prints, so the brief arrives unchanged however long it is. The brief ends in an id hashed from everything above it, the report has to carry that id, and `record fixer` refuses one that doesn't match the brief the ledger produces now. The subagent's result reports its tokens and duration, and the orchestrator passes them to `record fixer` as `--tokens` and `--minutes`. Its dollar cost isn't visible to the runner, since it bills the user's session, so the PR comment says so rather than guess.

Why not subagents throughout: a subagent shares the session's environment, settings, hooks, MCP servers and permissions, the skills CLI installs no agent definitions (so per-role tool limits would be words only), and the orchestrator would be writing the certifier's prompt after reading the fixer's report. The finder and the certifier must not see anything beyond their brief, so they start headless from the runner.

It runs in both rounds. In the AI rounds its list is the proven fails. In the human round it's the person's fix decisions in their words, with how they want each solved, and there's no `needsPerson`, since everything is theirs already. Each brief names the commit its round starts at, and the brief id covers that too, so commits the person made by hand before briefing it are theirs, never counted against the fixer.

A headless fixer, for agents without subagents, waits for the Codex port.

## What it can't promise

- **The session knows who's signed in.** With a subscription login, Claude Code tells it the account's email. That's the login, not the project.
- **Paths carry meaning.** A repository called `smoke` or `test` tells the finder something. Name things like a real project when you want a blind run.
- **Deny rules don't sandbox a shell.** Read, Glob and Grep are fenced to the repository and scratch folder, but Bash isn't, and Claude Code's own refusal message suggests trying another tool. A determined script could still read or write past the rules. The rules stop habits and accidents, and the runner catches what slips through. It snapshots tracked and untracked files, the gitignored entries (folders collapsed, so a dev server rewriting its own cache doesn't count), HEAD and the branch before and after every run. It refuses to file a run that changed a tracked or untracked file, and it holds back a run with new gitignored paths until the user confirms each one.
- **It can't tell who ticked a box.** The person and the runner use the same GitHub account, so a tick, or a word in the person's notes, looks the same whoever made it. The runner checks that a finding's words are in the person's issue, but not who wrote them. "Only the person ticks checks" is held up by the skill's instructions, not by code. If anyone stands in for the person (in a smoke test, say), say so in a comment on their issue.
- **One engine.** The finder drives Chromium (branded Chrome or Edge). Behaviour in WebKit and Firefox is always a person's check.
- **Built-in plugins still load.** Claude Code's own built-ins (security, privacy, telemetry) appear even in safe mode. The backend allows those, minus the AGENTS.md one, and stops a session on anything else.

## Run records

Each finder and certifier run keeps a local record in `~/.local/state/actua11y/runs/<owner>__<repo>/<run-id>/` (or under `$XDG_STATE_HOME`):

- `meta.json`: the run, its role, and for a certifier pass the list it was handed, frozen when it started
- the filled `brief.md`
- `transcript.jsonl`
- `report.json`
- `filed.json`, for a finder run

Transcripts stay local because they're large and can hold secrets. The issues and the PR comments record where they are.

Nothing else is kept locally. The loop's state, the ledger, rides in the agent issue's body, and every raw report rides in a comment, so `status` and every loop command rebuild everything from GitHub alone.
