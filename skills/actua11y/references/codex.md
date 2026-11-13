# actua11y in Codex

This is Lemon's best-faith effort, and it guarantees nothing. The Codex backend starts the finder and certifier with `codex exec`. Pass `--backend codex` to every command that starts or describes one of those sessions; the default backend remains Claude Code.

## Intake

Ask for a model and effort. The default is `gpt-6.1-sol` at `high`; availability depends on the user's Codex account. Codex reports tokens, not dollar cost. Say that the runner cannot enforce a dollar budget or a turn cap for Codex, and that the wall-clock timeout is the cap. The fixer is a subagent in the user's own session, and its usage comes from that session's report.

## How a session starts

The brief goes to `codex exec --json` on stdin. The backend was exercised with `codex-cli 0.167.0-alpha.3.2` on macOS. The runner itself must be allowed to launch Chrome and create a child sandbox; an enclosing Codex sandbox can prevent both, so the orchestrator may need to run the runner outside that sandbox with the user's approval.

| Layer | What the backend does | Limit |
|---|---|---|
| Environment | Starts with a short allowlist, a temporary `HOME` and `CODEX_HOME`, and a copy of the existing `auth.json` when present | An `OPENAI_API_KEY` or network proxy is passed through when present. The temporary home is deleted after the session and its corrections, including its sign-in copy; a machine crash can prevent cleanup |
| Settings and context | Uses `--ignore-user-config`, disables project instructions, bundled skills, apps, plugins and web search, and inspects `codex debug prompt-input` before starting | Prompt inspection checks the generated prompt for skill, app and user instruction markers and unexpected top-level tool namespaces. It is not an inventory event from the actual session and cannot prove every possible source of context |
| Session history | Stores the session only in the temporary home, then resumes it there for report corrections | It does not use `--ephemeral`: Codex cannot resume an ephemeral session. The temporary history is deleted with the home |
| Permissions | Uses a read-only profile that denies the filesystem root, opens system runtime paths and the repository for reading, opens the scratch folder for writing, and denies off-limits paths inside the repository | The profile also opens system paths needed to execute tools. Platform sandbox behavior varies; the runner still checks for repository changes and off-limits paths named in tool calls |
| Command rules | A temporary rules file forbids direct `git`, `gh`, and package-install commands. The brief forbids web use and subagents | Prefix rules do not cover every shell construction or indirect invocation. Some denied requests do not appear as command items in the JSON stream, so their count is not available |
| Browser | The runner starts a Playwright browser server on loopback outside the Codex sandbox; the kit and custom scripts connect to it | Chrome could not start inside the macOS sandbox tested. The browser runs with the runner's permissions, not the finder's filesystem sandbox, and its endpoint allows a connected client to control it. Treat the endpoint and audited pages as trusted for the run. The server is closed when the run ends |
| Model and limits | Pins the requested model and reasoning effort; kills the session at the wall-clock timeout | The stream does not report dollar spend or model turn count. Token counts and elapsed time are recorded, and correction rounds share the timeout |

The backend translates Codex command-execution items into inputs for the runner's existing off-limits check. It records the final messages and token usage from the JSON stream. It cannot count every denied tool call. The runner still checks the working tree before and after the session.

## The dry run

`runner.ts dry-run --backend codex` checks the assembled prompt and asks the model, without using tools, what it knows. Unlike Claude Code, Codex still exposes built-in tool namespaces to that session; the dry run asks the model not to use them and rejects command calls it observes. Prompt inspection reports the requested model and tool namespaces, not a model-confirmed inventory. Read the model's answer before proceeding. A clean dry run for the same backend, model and effort is required within six hours.

## The certifier and fixer

The certifier uses the same backend, browser arrangement and fences as the finder, with a different brief. The fixer runs as a subagent in the user's own session and receives the runner's brief unchanged; its result goes through `record fixer`. The runner-owned browser does not make the certifier's filesystem or network access equivalent to the shell's sandbox.

## What it can't promise

The rules prevent common accidents, not every indirect command or access through the browser. A session controlling that browser can attempt to read files available to the runner, including the temporary sign-in file, even when its shell cannot read them. The model can infer facts from the repository path. The browser and any local site may reach the network; no port isolation is promised. The dry-run prompt inspection is not a complete proof of everything the model could see, and the CLI's event format or sandbox may change. Only one browser engine is exercised, and a person still needs to make the checks a machine cannot settle.

## Run records

The local run records and GitHub ledger are the same as in [Claude Code](claude-code.md). The temporary Codex home and its session history are removed after the run; the runner's transcript and run records remain in the usual state directory.
