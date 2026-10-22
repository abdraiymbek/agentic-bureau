# Project format

An Omen Flow project is an ordinary folder. This is what a project created by the Rust host
contains (observed on a project built with `pnpm fixture:rover`):

```text
<Project>/
  omenflow.project.json         identity and marker version
  README.md                     written once at creation; says what the folder holds
  artifacts/                    working files of revisions (sources, meshes, attachments)
    requirements/ research/ concepts/ components/ mechanical/
    electronics/ calculations/ software/ assembly/ tests/
  exports/                      build packages, archives and part exports the person asked for
                                (agents write their exports only here)
  .omenflow/
    state.sqlite (-wal, -shm)   the engineering record (SQLite, WAL mode)
    objects/<xx>/<sha256>       immutable content-addressed files
    work/<sessionId>/           one folder per agent session (below)
    chat/conversations.json     the conversation pane's turns and the host's gate records
    recovery/                   rename journal, idempotency result journals
    cache/render-rust-v1/       render results by input fingerprint (regenerable)
    cache/views-v1/             pictures drawn by cad_view and image_view (regenerable)
```

## Canonical state

`state.sqlite` is the only writable store of engineering truth. It is **schema 1**: the tables
`meta`, `project`, `artifact`, `revision`, `edge`, `proposal`, `decision`, `bom_line`, `offer`,
`job`, `event`, `stale`, `materialization`, `idempotency`, `session` and the FTS5 table
`artifact_fts` (`crates/storage/src/schema_v1.sql`). Revisions are immutable; an artifact's
`selected_revision_id` is its baseline.

`omenflow.project.json`:

```json
{ "format": "omenflow-project", "version": 1, "id": "<uuid>", "name": "..." }
```

A project whose marker names a newer version opens read-only, from a private snapshot, so
nothing (not even SQLite's WAL recovery) writes to it.

### Compatibility rules

V1 keeps schema 1 and stays openable by earlier builds. Everything it adds is additive:

- a lazily created partial index `idx_job_cad_check_artifact` on `job` (SQLite JSON1, which
  every build bundles);
- `meta` keys: `work.active` (the part the agent is working on and its next CAD action) and
  `terminal.exportConsent`;
- event types `graph.changed`, `artifact.renamed`, `impact.propagated` with `reconciled: true`
  (recorded when opening repaired freshness), `proposal.resolved` with state `superseded`, and
  `reverted: true` on `baseline.changed`; agent-origin events carry `data.sessionId`;
- proposal `impact.supersedesProposalIds` / `impact.supersededByProposalId`, and
  `impact.answeredByRevisionId` on a proposal a newly accepted baseline already contained;
- a `commitOrder` in the inputs of committed CAD check jobs (the check committed last decides,
  among the checks a build reads; see [going back to 0.2.3](#going-back-to-023));
- CAD evidence from checker `omenflow-rust-mesh-checks-v3` (0.2.4), beside readable v2 and v1
  and TypeScript v4 evidence. Since 0.2.4 evidence may carry `spec` (listed items, linked
  requirements and, for a changed scope, `replaced` and `checkChanges`) and the check job's
  inputs `expect.spec` and `requirementIds`, while the evidence stays version 1;
- an optional `features` list in requirement payloads (0.2.4);
- the event type `cad.exported` (a part written as STEP, STL or SCAD: `format`, `method`,
  `exact`, `destPath`, `bytes`, and `projectPath` when the file is inside the project) and the
  job kind `cad_export` (tool `omenflow-step`), whose inputs hold no machine path: a
  project-relative destination, or only the file name of one outside the project, which its
  error also names by file name;
- `for` in the inputs of a `cad_render` job that renders a revision for `cad.view`,
  `cad.inspect` or `cad.check` and commits nothing to it (0.2.4); an earlier build ignores it;
- the sidecar files under `.omenflow/work/` and `.omenflow/cache/`, including the pictures in
  `.omenflow/cache/views-v1/` (0.2.4): PNG files named by the SHA-256 of their bytes,
  drawn for an agent by `cad_view` and `image_view`. They are never read back as a cache, are
  pruned to the newest 256 files and 128 MiB, and an earlier build ignores the folder;
- in `.omenflow/chat/conversations.json`, turn fields `gate` (the host's completion-gate
  record), `continues`, `model`, `resolvedModel`, `usage` (tokens only) and
  `cliConversationId` (0.2.4); turn keys a later build adds are kept on save, and an earlier
  build drops these fields when it saves the conversation again;
- `alsoRan` in `calls.jsonl` records (0.2.4): what the host also ran inside the call, such as
  the check a write with `expect` ran.

`cad.export` records an event and, for STEP, a job, so it now counts as a change: a project
opened read-only refuses it with `READ_ONLY`, where earlier builds copied STL and SCAD files
from such a project.

No table, column or constraint was renamed or changed.

### Going back to 0.2.3

A 0.2.3 build opens a project that 0.2.4 has worked on and keeps its data, but it reads CAD
checks and conversations differently:

- **It ignores every check recorded by 0.2.4** (checker v3). Each revision shows its newest
  check from 0.2.3 or earlier, even when a later 0.2.4 check of that same revision failed,
  changed scope or left items unasserted. A part whose newest 0.2.4 check failed can therefore
  read there as verified, and 0.2.3 lets a person approve it and build with it. A revision
  checked only by 0.2.4 shows as without a committed check.
- It cannot accept the scope of a check recorded by 0.2.4: accepting or approving with that
  evidence is refused with `REVISION_CONFLICT`, because 0.2.3 does not see the evidence.
- It still compares its own checks with the scope a 0.2.4 check recorded. When that check
  listed items (`expect.spec`), which 0.2.3 strips from its own checks, every 0.2.3 check of the
  part reports `spec` as dropped: with `autoCommit` it stays an uncommitted trial, and
  otherwise it commits as `scope_changed`, even when a person runs it with the arguments its
  gate suggests. The part is verified there again only after a person accepts a scope.
- It reads requirement `features`, but its interface drops them on the next edit and its agent
  tools refuse them; its gate echoes `expect.spec`, which its agent tools also refuse.
- Any change it makes to the conversations rewrites the file and drops the 0.2.4 turn fields
  above from every turn: sending a turn, attaching a part to a conversation, or marking a
  running turn interrupted when the project opens. A continuation then loses its
  `continues` record, so both builds show Omen Flow's continuation text as the person's own
  message, and 0.2.4 replays it as the person's to an agent CLI that starts a new conversation.

So after going back, do not rely on a part's verified state there until it is checked again,
and when returning to 0.2.4, check again the parts 0.2.3 checked or approved. The job history
keeps every check with the checker that recorded it.

## Objects and working files

`.omenflow/objects/<xx>/<sha256>` holds immutable blobs (at most 64 MiB each); revisions name
their files by path, hash and role (`source`, `output`, `attachment`). After a revision commits,
its files are written into `artifacts/` (for example `artifacts/mechanical/camera-tray.scad`).

A working file that was edited outside Omen Flow is not overwritten: the revision's bytes are
written beside it as `<file>.omenflow-conflict-<ms>` and the operation result carries a warning.
The Rust host does not watch the folder; `artifact.import_file` attaches an existing project
file to an artifact as a new draft when someone asks for it. Paths that leave the project,
including through symlinks, are refused, and working files can never be written into
`.omenflow/` or over the marker.

## Agent session folders

`.omenflow/work/<sessionId>/` holds two kinds of files:

| File                                                             | Lifetime                                               | Contents                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.json` (Claude Code), `guide.md`, `gemini.json`, `qwen.json` | Written `0600` at start, removed when the session ends | The CLI's MCP configuration and guidance. Claude Code's `mcp.json` contains the session's bridge token; the others reference the variables                                                                                                            |
| `calls.jsonl`                                                    | Kept                                                   | One `AgentCallRecord` per agent call: `seq`, `at`, `projectId`, `sessionId`, `tool`, `op`, `via`, `ok`, `code`, `message` (one line, at most 300 characters), `durationMs`, `mutating`, `artifactIds` (at most 8), `notes` (input repairs), `alsoRan` |
| `session.json`                                                   | Kept                                                   | The session summary: `sessionId`, `adapterId`, `model`, `profile`, `startedAt`, `endedAt`                                                                                                                                                             |

The ledger loads these files the first time a project's activity is read or a session starts
(the newest 200 session folders; the latest 2,000 records stay in memory), so the activity rail
and `agent.activity` survive a restart.
**Call arguments and results are never stored**, and neither are the terminal's bytes: the
scrollback lives in memory for the running session only. Removing a session folder removes
that session's call history and nothing else.

A Custom CLI also gets a block in the project's own `AGENTS.md`, between
`<!-- omenflow:guide:begin … -->` and `<!-- omenflow:guide:end -->`; text outside the markers is
never touched (see [agent adapters](agent-adapters.md)).

## What is stored where

| In the project                                                                   | Not in the project                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Artifacts, every revision, proposals, decisions with rationale, edges, freshness | Settings: agent executables, arguments, environment, model and profile choices                 |
| Jobs with their command, log, tool version and inputs                            | The OpenSCAD and Python paths chosen in Settings                                               |
| Events, including agent session attribution                                      | Bridge tokens (in memory; the only copy on disk is a running Claude Code session's `mcp.json`) |
| Session rows: adapter, executable path, state, exit code, last error             | Terminal output                                                                                |
| The agent call ledger (without arguments)                                        | Window state, recent projects                                                                  |

Settings live in the per-user application data folder (`settings.json`, plain JSON;
`reservations.json`, `window-state.json` and `run/` for the bridge socket). Some machine paths do
reach the project record: a session row keeps the executable path, and a render identity records
the OpenSCAD executable in `renderIdentity.options`.

## Archives

`project.export_archive` writes a ZIP that `project.import_archive` accepts, and checks that it
would before writing anything:

- `omenflow.project.json`, `README.md`, `artifacts/**`, `.omenflow/objects/**`;
- `.omenflow/state.sqlite` from a private copy with machine paths removed (a session's
  executable becomes its program name; project, home and temporary prefixes in job logs, errors,
  commands and event data become `<project>`, `~` and `<tmp>`, and other absolute paths in job
  logs and errors, such as a Python on `PATH`, are cut to their last component, up to any space
  in them), vacuumed with `secure_delete`;
- `snapshot.json`, a portable JSON rendering of the record, made from that copy;
- `archive-manifest.json`, which lists what was excluded: credentials, machine settings, machine
  paths, cache, `work` (so the agent call ledger) and, without consent, terminal logs. This
  build records no terminal history, and the manifest says `none-recorded` or `excluded`.

Revision payloads are immutable and are not rewritten, so a render identity's OpenSCAD path
stays; the export's `notes` say so. The export leaves out invalid object files and interrupted
writes and counts them in `notes`. Archives are bounded (128 MiB compressed, 512 MiB total,
128 MiB per entry, 10,000 entries). Import validates names, sizes and object hashes in a staging
folder before publishing the project. An archive whose project identity conflicts with a known
project is refused (`REVISION_CONFLICT`) before anything is extracted; importing it again with
`newIdentity: true` makes a copy with a new id.

Archives do not contain readable per-artifact views (`artifacts/<type>/<slug>.md|json`); the
earlier TypeScript core wrote them and the Rust core does not.
