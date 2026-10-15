# Agent adapters and the agent layer

An agent CLI authors drafts; a human decides. The Rust agent host
(`crates/agent-host`) starts the CLI in a terminal, gives it the Omen Flow
tools over MCP, shapes what it is shown for the model it runs, and records
every call it makes.

## Adapters

Adapters are data (`crates/agent-host/src/adapters.rs`, `ADAPTERS`): one
record per CLI with its executable names, version probe, MCP injection
method, tool pre-approval, timeouts, model flag, guidance channels, suggested
models with their tiers, a `verified` flag and a documentation link. Adding a
CLI that uses an existing injection method is one more record.

| Adapter                   | Verified on this build | MCP injection                                                                     | Pre-approval                                           | Guidance                                                        | Model                                                                | Tool timeout                                     | Resume                      |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| `codex` Codex CLI         | yes (0.156.1)          | `-c mcp_servers.omenflow.*` overrides; credentials forwarded by name (`env_vars`) | `default_tools_approval_mode="approve"`                | MCP instructions, `-c developer_instructions=`                  | `-m`; `ollama/…` and `lmstudio/…` ids add `--oss --local-provider …` | `tool_timeout_sec=330`, `startup_timeout_sec=20` | no                          |
| `claude-code` Claude Code | yes (2.1.287)          | `--mcp-config <work>/mcp.json` with `timeout` and `alwaysLoad`                    | `--allowedTools mcp__omenflow`                         | MCP instructions, `--append-system-prompt-file <work>/guide.md` | `--model`                                                            | 600 s (`timeout` in `mcp.json`)                  | `--session-id` / `--resume` |
| `opencode` OpenCode       | no                     | `OPENCODE_CONFIG_CONTENT` inline JSON                                             | `permission: {"omenflow_*": "allow"}`                  | MCP instructions, `instructions: [guide.md]`                    | `-m provider/model`                                                  | `timeout: 330000`                                | no                          |
| `gemini` Gemini CLI       | no                     | `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=<work>/gemini.json`                              | `"trust": true`, `--allowed-mcp-server-names omenflow` | MCP instructions                                                | `-m`                                                                 | `timeout: 600000`                                | no                          |
| `qwen` Qwen Code          | no                     | `QWEN_CODE_SYSTEM_DEFAULTS_PATH=<work>/qwen.json`                                 | `"trust": true`                                        | MCP instructions, `--append-system-prompt`                      | `-m`                                                                 | `timeout: 600000`                                | no                          |
| `custom` Custom CLI       | no                     | none: bridge variables and `omenflow` on PATH                                     | n/a                                                    | bounded `AGENTS.md` block                                       | none                                                                 | n/a                                              | no                          |

"Verified" means the launch line was checked against the installed CLI's
`--help` output and binary on the build machine. The OpenCode, Gemini CLI and
Qwen Code records follow those CLIs' documentation and have not been run
here; Settings shows them as "Documented, not verified here" (the Custom
CLI as "Not verified here").
Neither verified adapter has been run against a live model by the automated
tests: tests use stand-in executables and assert the exact arguments.

Codex resume is not offered: `codex resume --last` continues the most recent
conversation in the folder, which may be one Omen Flow never saw. Claude Code
is started with `--session-id <Omen Flow session id>`; "Start again" resumes
that conversation with `--resume <id>` when the previous session made at
least one tool call (so a conversation exists), and starts fresh otherwise.

### Detection and versions

The search path is the login shell's PATH (resolved once, off any request
thread, from `$SHELL -ilc`), then the inherited PATH, then `~/.local/bin`,
`~/.npm-global/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/.opencode/bin`,
`~/.volta/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, and on
Linux `/home/linuxbrew/.linuxbrew/bin`, `~/.linuxbrew/bin` and `/snap/bin`. Folders
inside a running AppImage are left out. A candidate must be an executable file. The version probe runs `<cli>
--version` with a two-second bound and parses the first `major.minor[.patch]`.
A version is recognised when it is at least the oldest supported version and
not a later major release than the one checked (Codex `>= 0.150.0`, Claude
Code `>= 2.1.0`); an unverified adapter's version is never "recognised".

`connection.test` runs the CLI's version probe, checks the bundled helper,
then makes two real round trips through the helper, run in the project
folder with a throwaway grant: `omenflow call project_summary` (the result
must be a project summary) and `omenflow mcp` `initialize` + `tools/list`.
Each step is reported in `steps`; the CLI's own MCP start-up is only
exercised when a session starts, and the result says so.

`connection.list` reports every adapter with its V1 fields and the launch
arguments saved for it (`args`); configured environment variables are never
listed.

## Sessions

`session::plan_launch` is a pure function: for a project, adapter, model and
profile it returns the executable, arguments, environment, the files to
write, the guidance text and whether `AGENTS.md` carries the block. The
terminal host spawns the plan in a PTY; a headless host can spawn the same
plan with `LaunchMode::Headless` (`codex exec --json --skip-git-repo-check …
-`, `claude -p … --output-format stream-json --verbose --permission-mode
dontAsk`), writing the prompt to standard input.

- Files live in `.omenflow/work/<session>/`, are written `0600`, and are
  removed when the session ends however it ends. Only Claude Code's
  `mcp.json` holds the token; the other adapters reference the variables.
- `bootstrap.md` and `OMENFLOW_BOOTSTRAP` are gone: project context comes from
  `project_summary`, which the instructions tell the agent to call first.
- Inherited `OMENFLOW_*` variables are removed, configured variables cannot
  replace the session's credentials, `TERM=xterm-256color`,
  `COLORTERM=truecolor`, and `LANG=en_US.UTF-8` when none is inherited.
- A session starts at the size `terminal.start` asks for, or the size the
  project's terminal was last resized to. Output is decoded as UTF-8 across
  read boundaries; the 256 KiB scrollback is trimmed at a line start or an
  escape sequence, never inside a character. Stop sends SIGTERM to the
  process group, waits up to two seconds for the CLI and everything left in
  its group, then SIGKILLs the group.
- `SessionInfo` carries `model`, `profile`, `profileSource`, `toolCount`, and
  live `calls`, `errors` and `waitingForReview` (true while a
  `proposal_wait` runs). `exitCode` is recorded only for a process that
  exited with one; a session ended by a signal (a stop included) has none.
  `lastError` says why a CLI that ended on its own failed.

### Headless runs (evaluations)

`omenflow-host` prepares a non-interactive run with the same wiring a terminal
session gets (`PtyHost::prepare_headless`): `POST /api/agent/launch` with
`{projectId, adapterId, model?, profile?, executablePath?, args?}` (the launch
fields of `terminal.start`), behind the host's token and loopback checks. The
answer is the plan: `sessionId`, `profile`, `profileSource`, `executable`,
`args`, `cwd`, `env` (set over the inherited environment), `envDefaults` (set
only when absent), `scrubbedPrefix` (`OMENFLOW_`: remove inherited variables
with it first) and `files` (`{path, contents}`, write them owner-only). The
caller spawns the CLI, writes the prompt to standard input and closes it; when
it is done it removes the files and revokes the grant with
`POST /api/agent/revoke {sessionId}`. Only Codex CLI and Claude Code have a
headless mode; the others are refused before a grant is issued.
`POST /api/agent/session` still issues bare bridge credentials for a client
that speaks the bridge itself; it takes an optional `profile`.

### AGENTS.md

Only a CLI with no other guidance channel (the custom adapter) gets a block
in the project's `AGENTS.md`, between `<!-- omenflow:guide:begin … -->` and
`<!-- omenflow:guide:end -->`. Text outside the markers is never touched; a
begin marker without an end marker is left alone. Set `OMENFLOW_AGENTS_MD=off`
in the custom adapter's environment to keep the block out. The unbounded
guide earlier builds wrote (from `<!-- omenflow:agent-guide -->` through its
last sentence, "request review unless asked.") is removed on the next start
of any session; text the person added above or below it stays. A file that
held only Omen Flow's text is deleted.

## Capability profiles

The profile is fixed on the session grant (`Grant { project_id, session_id,
profile, adapter_id, model }`). Resolution (`profile::resolve_profile`): an
explicit `compact|standard|full` setting wins; `auto` maps the launch model
id by whole words — `haiku`, `luna`, `mini`, `nano`, `lite`, `ollama/`,
`lmstudio/`, `:<n>b` size tags or a `--oss`/`--local-provider` argument →
compact; `opus`, `fable`, `astra`, `sol`, `pro`, `max` → full; any other id →
standard; no model → the adapter's default (standard; custom: compact).

| Profile  | Tools listed                                 | Listing as sent to the model | Result cap   |
| -------- | -------------------------------------------- | ---------------------------- | ------------ |
| compact  | 13 core tools: summary + compact schema      | 6,290 chars                  | 6,000 chars  |
| standard | 43: description + input schema (no overlays) | 57,288 chars                 | 16,000 chars |
| full     | 57: description + input schema               | 64,010 chars                 | 32,000 chars |

Sizes are `name`, `description`, `inputSchema` as compact JSON, measured on
the registry of this build by the agent host's
`listing_sizes_stay_within_their_budgets` test; with `title` and
`annotations` the `tools/list` payloads are 7,978, 62,936 and 71,486
characters. Only compact uses the compact schema overlays, as the
TypeScript `toolListing` does. Listed schemas drop `$schema`,
`additionalProperties: false` and `idempotencyKey` (still accepted when
sent). Every agent-allowed operation stays callable in every profile
through `tool_call`.

## The MCP server

`initialize` answers with the requested protocol revision when it is one of
`2025-06-18`, `2025-03-26`, `2024-11-05`, else `2025-06-18`, and returns
profile-specific `instructions` (at most 1,800 characters: what the server
is, the loop, "call guide_read for a playbook", "call work_status before you
finish"). Notifications are accepted; responses to requests the server never
sent are ignored. `project_summary`'s `next` never suggests work nobody asked
for: it names `guide_read` only for an empty project, as information.

Every `tools/call` goes through `dispatch_agent`:

1. The name is resolved in any form (`cad_check`, `cad.check`,
   `mcp__omenflow__cad_check`, any case); a form the listing does not use is
   reported in `notes`. An unknown name returns an `isError` result with
   `didYouMean`. A human-only operation returns `CAPABILITY_DENIED` with what
   to do instead.
2. `tool_call` validates its own input, then runs the named tool as if it
   had been called directly. `guide_read` serves the playbooks in
   `crates/agent-host/guides/`.
3. Input goes through `parse_agent_input`: lossless, reported repairs only.
   Unknown keys are refused with the allowed keys and the nearest one. The
   core then checks the units in content an agent writes (artifact payloads,
   a candidate's properties and attributes, wiring pins): a unit spelled out
   with one meaning becomes its symbol and is reported in `notes`; anything
   else, including a name with more than one meaning such as pound, is
   refused as `INVALID_UNITS` with each path, before anything is written.
   Writes a person makes are not refused this way.
4. A compact session asks operations that offer `detail: "brief"` for it.
5. The result is shaped for the profile: web pages are always bounded and
   marked as untrusted data; schemas returned by `tool_describe` are slimmed;
   `next` hints name tools by underscore name and add `via: "tool_call"` for
   tools the profile does not list; a successful save carries a `warnings`
   entry for any quantity whose unit the unit table cannot read; a result
   over the cap is cut with a `truncated` marker (`cut` paths, `how`, and
   `more` with the exact next-page call, in the cursor form when the call
   used a cursor). A cut page's `hasMore`, `nextOffset` and `nextCursor`
   continue after the last item shown. `artifact_read` returns its revision
   whole; a list or a text cut anywhere else inside content (`payload`,
   `files`) becomes `{omitted, shown, total, items | preview}`, which fails
   validation if it is saved back. Schemas, source files, playbooks and the
   tool catalogue are never cut.
6. The reply is compact JSON text plus the same object as
   `structuredContent`. Repairs are in `notes`. Errors are `isError` results
   with `code`, `message`, `repair`, `issues` (path, message, and in standard
   and full the expected and received values), `example` and `notes`.
7. The call is recorded in the ledger.

`proposal_wait` is bounded 30 seconds below the CLI's own tool timeout,
reports `timedOut`, and marks the session as waiting for review while it
runs.

## The ledger

Every call through `dispatch_agent` becomes an `AgentCallRecord` (`seq`,
`at`, `projectId`, `sessionId`, `tool` as called, `op` that ran, `via`, `ok`,
`code`, `message`, `durationMs`, `mutating`, `artifactIds`, `notes`);
arguments are never stored, a stored error message drops any value the call
sent (`received …`), and `artifactIds` keeps only ids. Records are kept in
memory per project (the latest 2,000) and appended to
`.omenflow/work/<sessionId>/calls.jsonl`, with the session's summary in
`session.json` beside it, so history and the per-project sequence survive a
restart. When a project folder moves, the ledger loads the history in the
new folder and writes there; it never re-creates a folder whose `.omenflow`
is gone. `BridgeServer::set_on_call` receives
each record as it is stored (host channel `omenflow:agent:call`);
`BridgeServer::agent_activity` serves `agent.activity`.

## The `omenflow` helper

See `native/omenflow-bridge/README.md`: `omenflow mcp`, `omenflow call <tool>`
(either name form, optional `--input`, structured errors with the repair),
`omenflow guide [topic]` and `omenflow status` for CLIs without MCP.

## Not built, and why

- **Stop hooks** (a Claude Code or Codex hook that runs `omenflow status`
  and refuses to let the agent finish while `work_status` reports blockers).
  Both CLIs document a `Stop` hook that can block with a reason, and Claude
  Code accepts hooks for one session through `--settings`. Whether the hook
  fires, and how either CLI treats a block, can only be observed in a live
  model session, which this build's tests do not run. The completion gate is
  therefore requested in the instructions and every playbook, and the
  interface shows the same ledger, so a false "done" is visible.
- **Server-initiated messages** (`notifications/tools/list_changed`,
  progress, cancellation): the tool list never changes during a session, and
  the server answers one request at a time.
