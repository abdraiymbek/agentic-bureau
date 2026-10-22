# Omen Flow

Omen Flow is a local desktop engineering workspace. You bring an agent CLI (Codex CLI, Claude
Code, or another), it runs inside the app — as a conversation or in a real terminal — and it
drafts engineering work —
requirements, parts, CAD, calculations, wiring, tests — through Omen Flow's MCP tools. Nothing it
writes becomes the baseline until a person approves it. Approval records a decision; it does not
establish engineering validity.

Everything lives in the project folder: a schema 1 SQLite record, an object store of immutable
files, and readable working files. The packaged app is Rust (Tauri) with a React renderer in the
operating system's webview; it contains no Electron and no Node runtime.

**[Download Omen Flow 0.2.3](https://github.com/abdraiymbek/omen-flow/releases/latest)** — macOS (Apple Silicon) · Linux preview (x86_64, arm64) ·
Apache-2.0

## Install

### Requirements

- **macOS 13.3 or later on Apple Silicon**, or **Linux with glibc 2.35 or later** (Ubuntu 22.04
  or later, Debian 12 or later, Fedora 42 or later; the Linux build is a preview).
- **An agent CLI, installed and signed in.** Claude Code or Codex CLI are verified with this
  release; OpenCode, Gemini CLI and Qwen Code follow their documentation; any other CLI can run as
  a Custom CLI. Omen Flow does not include a model or an account.
- **OpenSCAD** for rendering and checking parts. It is not bundled; everything else works without
  it. macOS: `brew install --cask openscad@snapshot`. Linux: your distribution's package
  (`sudo apt install openscad`, `sudo dnf install openscad`).
- Optional: **Python 3.11–3.14 with OCP** (`cadquery-ocp-novtk==7.9.3.1.1`) makes STEP exports
  exact; without it they are faceted. It is not bundled; see
  [STEP export](docs/engineering-adapters.md#step-export).

### macOS

Download `Omen-Flow-0.2.3-macos-arm64.dmg` from the [latest release](https://github.com/abdraiymbek/omen-flow/releases/latest). The app is ad hoc signed to protect its contents,
but is not notarized by Apple. macOS may require approval on first launch:

1. Open the DMG and drag **Omen Flow** onto **Applications**.
2. Eject the DMG and open Omen Flow from Applications. If macOS says it cannot verify the app,
   dismiss that message.
3. Open **System Settings → Privacy & Security**, find “Omen Flow was blocked…” and choose
   **Open Anyway**, then confirm **Open** and authenticate if asked. macOS remembers the
   exception and may ask again after an update. See [Apple's instructions](https://support.apple.com/en-us/102445).

The DMG includes these steps in `INSTALL.txt`. If macOS reports the app is damaged, download
a fresh copy from the official release, verify it against `SHA256SUMS`, and
[report the problem](https://github.com/abdraiymbek/omen-flow/issues) if it persists.

### Linux (preview)

Download the file for your system and architecture (`amd64`/`x86_64` for most PCs, `arm64`/
`aarch64` for ARM machines) from the [latest release](https://github.com/abdraiymbek/omen-flow/releases/latest):

| System                    | File                              | Install                                                 |
| ------------------------- | --------------------------------- | ------------------------------------------------------- |
| Ubuntu 22.04+, Debian 12+ | `omen-flow_0.2.3_amd64.deb`       | `sudo apt install ./omen-flow_0.2.3_amd64.deb`          |
| Fedora 42+                | `omen-flow-0.2.3-1.x86_64.rpm`    | `sudo dnf install ./omen-flow-0.2.3-1.x86_64.rpm`       |
| Other distributions       | `Omen-Flow-0.2.3-x86_64.AppImage` | `chmod +x Omen-Flow-0.2.3-x86_64.AppImage`, then run it |

The `arm64` files are named the same way (`omen-flow_0.2.3_arm64.deb`,
`omen-flow-0.2.3-1.aarch64.rpm`, `Omen-Flow-0.2.3-aarch64.AppImage`). The packages install
**Omen Flow** in the applications menu and the `omen-flow` command, and apt or dnf pulls in
WebKitGTK and the other libraries. The AppImage needs FUSE 3 (`sudo apt install fuse3`) or
`APPIMAGE_EXTRACT_AND_RUN=1`. The Linux build has been installed and run in fresh Ubuntu, Debian
and Fedora containers, but not yet on a real desktop: please [report what you find](https://github.com/abdraiymbek/omen-flow/issues).

### Verify the download

Each release lists the SHA-256 of every file in `SHA256SUMS`. In the folder you downloaded to:
`shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS) or `sha256sum -c SHA256SUMS --ignore-missing`
(Linux).

### Update and uninstall

Install a newer release over the old one. Your projects live in the folders you chose and are
never changed by installing or removing the app. Application settings (recent projects, agent and
engine settings) are kept in `~/Library/Application Support/app.omenflow.desktop` on macOS and
`~/.local/share/app.omenflow.desktop` on Linux. To uninstall, move the app to the Trash (macOS) or
run `sudo apt remove omen-flow` / `sudo dnf remove omen-flow` (Linux); delete the settings folder
too if you want a clean slate. To build the app yourself, see [Develop and verify](#develop-and-verify)
and [release](docs/release.md).

## First use

1. Install OpenSCAD (macOS: `brew install --cask openscad@snapshot`; the engine is not bundled)
   and an agent CLI, signed in.
2. Open Omen Flow. On first launch an introduction plays: four short acts on a sample rover's
   map (see the whole, focus on one, decide), then setup steps that detect your agent CLI and
   OpenSCAD, pick Graphite or Paper and show the shortcuts. `Esc` skips it; Settings →
   Appearance plays it again. Then answer _What are you building?_ and choose an empty folder.
3. The project opens on the Agent tab's **Conversation**: write what you want and press Send;
   Codex CLI or Claude Code runs once per message. Switch to **Terminal** to run any agent CLI
   interactively: when exactly one is found (or the one you chose before is), it starts; with
   several you choose once; with none, the tab lists each with its install guide and **Set
   path…**. Settings (`⌘,`) holds each agent's model, tool profile and executable.
4. Ask the agent for work. Watch its calls in the activity rail; review its proposals under
   Decisions (`⌘⇧D`). Check what is still unproven in the Evidence lens (`⌘5`).
5. Export a project archive from the project menu in the titlebar (or the Files lens) to keep the
   history elsewhere; the build package exports approved deliverables.

Closing a project stops its agent. A project written by a newer build opens read-only.

## What 0.2 is

- **Three zoom levels (Lens).** The project seen through one lens — **Flow** (a causal map of
  every object, inputs left, consequences right), **Parts**, **Timeline**, **Files**,
  **Evidence** (`⌘1`–`⌘5`) — then one object on a stage between the rails of what it depends on
  and what it affects, then one decision. A left activity bar carries the Agent tab first. There
  is no dashboard. See [the design specification](design-system/design.md).
- **The introduction.** Once on first launch, over the launcher: the rover's causal map draws
  itself and lights a thread, the camera tray zooms into a live 3D stage, a proposal is approved
  and its impact travels the recorded links, then the setup steps do the real thing (agent CLI
  detection and choice, the OpenSCAD probe, theme, shortcuts, where everything lives). Nothing
  in it reaches a record; it is replayable from Settings, the launcher, `⌘K` or the catalogue.
- **The agent surface.** One per open project, shown as the Agent tab, a floating window or a
  dock (`⌘J`), with two panes. The **Conversation** runs Codex CLI or Claude Code headless once
  per message and shows the cards the run presents: a part in 3D with its dimensions, recorded
  objects, quantities, illustrative charts, choices and human review. Edit a card's values and
  Prepare attaches the exact values to your request; only Send runs the agent. The
  **Terminal** is one real PTY running any agent CLI, with a session bar of status, agent,
  model, tool profile, tools listed, and the calls and failures the host recorded. One agent
  works in a project at a time. The activity rail lists only calls from the host's ledger.
  “Ask agent” anywhere drafts an editable request in the active pane; it never sends for you.
  When a response ends with work that `work_status` still lists as unfinished, the turn shows
  Omen Flow's record of it, **Work not finished**, and Continue sends one fixed, labelled
  continuation; with Settings → Agents → **Continue once** (off by default) Omen Flow sends it
  itself, once per message you sent, labelled as its own. Each turn names its model: what the
  CLI reported, else the id Omen Flow passed. Omen Flow never parses or shows a CLI's cost
  figure in its own interface. Conversations are kept in `.omenflow/chat/conversations.json` in
  the project folder; project archives do not include them.
- **Adaptive capability profiles.** Each session is fixed to `compact`, `standard` or `full`. A
  small model (Haiku, Luna, mini, local models) gets 13 flat tools, playbooks on demand
  (`guide_read`), reported input repairs and a server-owned completion gate (`work_status`). A
  large model keeps the full surface of 58 tools. Verification rules are the same in every
  profile, and every agent-allowed operation stays callable through `tool_call`. Details:
  [agent adapters](docs/agent-adapters.md).
- **Evidence.** The Evidence lens is the requirement → evidence matrix from `project.coverage`:
  each requirement's target, coverage (covered, partly covered, out of date, no evidence) and the
  linked calculations and tests with their recorded results. Pass or fail appears only when a
  test recorded a verdict; it is never inferred by comparing numbers.
- **Decisions.** Proposals are reviewed one at a time with field-level diffs, CAD comparison,
  verification status and impact. Approval is refused when the baseline moved since the
  proposal was drafted (`REVISION_CONFLICT`), a newer proposal for the same objects supersedes
  the old one, and agents cannot approve, accept or revert anything.

### Agent CLIs

| CLI         | Status in this build                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| Codex CLI   | Verified: launch line checked against the installed CLI (0.156.1); supports `>= 0.150.0` |
| Claude Code | Verified: launch line checked against the installed CLI (2.1.287); supports `>= 2.1.0`   |
| OpenCode    | Documented, not verified here                                                            |
| Gemini CLI  | Documented, not verified here                                                            |
| Qwen Code   | Documented, not verified here                                                            |
| Custom CLI  | Any executable; gets the `omenflow` helper on PATH and a bounded `AGENTS.md` block       |

“Verified” means the arguments Omen Flow passes were checked against that CLI's `--help` and
binary on the build machine, and the automated tests assert them with stand-in executables.
The tests do not run a live model. Live model runs are recorded separately in the
[V1 readiness record](audit/v1/README.md).

## Architecture

| Path                                                        | Role                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/`                                       | Source of truth for operations, entities, units and errors (TypeScript, zod). `pnpm contracts:export` writes `crates/contracts/registry.json`                                  |
| `crates/contracts/`                                         | The exported registry (106 operations), input validation, lossless agent-input repair, typed errors                                                                            |
| `crates/storage/`                                           | SQLite schema 1, FTS5 search tables, content-addressed object store, project path guards                                                                                       |
| `crates/core/`                                              | The domain: revisions, proposals and decisions, freshness graph, CAD (OpenSCAD + mesh checks), calculations, parts and BOM, wiring, tests, completion gate, coverage, archives |
| `crates/agent-host/`                                        | The shared `Host`: command routing, PTY sessions, adapters, capability profiles, bridge socket, MCP server, call ledger, playbooks                                             |
| `apps/rust-desktop/`                                        | Thin Tauri shell over `Host`: window, events, isolated research webview, menu, single-instance lock                                                                            |
| `apps/headless/`                                            | `omenflow-host`: the same `Host` over loopback HTTP and server-sent events, for the design preview, conformance tests, fixtures and evaluations                                |
| `apps/desktop/src/renderer/`                                | The Lens renderer (React, Vite, zustand, three.js, xterm)                                                                                                                      |
| `native/omenflow-bridge/`                                   | The bundled `omenflow` helper an agent CLI calls: `mcp`, `call`, `guide`, `status`                                                                                             |
| `packages/{core,storage,agent-host,mcp-server,engineering}` | The earlier TypeScript implementation, kept as a behaviour oracle for `pnpm test`; not shipped                                                                                 |
| `tests/conformance/`                                        | Dispatch-level corpus run against the Rust host                                                                                                                                |
| `design-system/`                                            | Lens tokens, fonts, brand, specification and verification record                                                                                                               |

The legacy TypeScript packages answer the same operation names, and the domain tests in
`pnpm test` run against them. Operations and inputs only the Rust host implements are refused
there with a typed error instead of being silently ignored. New behaviour belongs in Rust and the
contracts. See [architecture](docs/architecture.md).

## Develop and verify

Requirements: Node 24 (`.nvmrc`), pnpm 9.15.9, the stable Rust toolchain
(`rust-toolchain.toml`), and OpenSCAD for the CAD engine tests. [Development](docs/development.md)
has every command and what it needs.

```sh
pnpm install --frozen-lockfile
pnpm rebuild:node            # node-pty from source, for the legacy PTY tests (macOS)
pnpm contracts:check         # registry.json matches the TypeScript contracts
cargo test --workspace       # Rust core, storage, host, headless, desktop shell
pnpm test                    # legacy TypeScript oracle and renderer tests
pnpm test:conformance        # the corpus against the Rust headless host
pnpm typecheck
pnpm lint
pnpm design:preview          # the real renderer on the Rust headless host, disposable data
```

`pnpm design:preview` builds `omenflow-host` and the `omenflow` helper, builds the rover and drone
fixtures through the host in a temporary folder, and serves the renderer on
`http://127.0.0.1:5173` (`OMEN_PREVIEW_PORT` changes the port). Open the address it prints: it
carries a one-time key that the page trades for a cookie, so only that browser can use the
preview. Terminals and agent settings are off unless it was started with
`OMEN_PREVIEW_AGENTS=1`, because a Custom CLI runs any executable and Codex CLI and Claude Code
run models and may update themselves. The temporary folder is removed when the preview stops.
Research browsing is not available in the headless host.

The desktop commands open or build the native app:

- `pnpm dev` builds the helper, starts the renderer's Vite server on port 5174 and runs
  `tauri dev`.
- `pnpm make` (alias `pnpm package`) builds the helper, the static renderer and the release Tauri
  app: `target/release/bundle/macos/Omen Flow.app` and a DMG on macOS, ad hoc signed
  (`CI=true pnpm make` skips the DMG's Finder layout where a session cannot script Finder).
- `pnpm smoke:packaged` launches that bundle with disposable state and drives the helper through
  a real agent grant. `pnpm smoke:headless` runs the same checks against `omenflow-host` with no
  window.
- `pnpm release:macos` signs and notarizes; it refuses to run without Apple credentials. See
  [release](docs/release.md).

The live-model evaluation of the agent layer is `pnpm eval:agent -- --out <dir>`
([`evals/agent/`](evals/agent/README.md)). It runs real Claude Code and Codex CLI sessions on the
Rust headless host and **spends your model account's credits**: Claude Code cells are capped at
2 USD and 40 turns, every cell at 10 minutes, and Codex has no spend flag, so the wall-clock
limit is its only bound. `--reference good` and `--reference bad` check the judges with
scripted sessions and no model.

## Limits

- The macOS app (version 0.2.3, identifier `app.omenflow.desktop`, macOS 13.3 or later, Apple
  Silicon only) is ad hoc signed, not notarized, so macOS asks you to allow it once (see
  [Install](#macos)). Intel Macs and Windows are not supported by this release.
- Linux packages (`.deb`, `.rpm`, AppImage; unsigned) are built by `node scripts/linux-package.mjs`
  in an Ubuntu 22.04 container and need glibc 2.35 or later (Ubuntu 22.04 and later, Debian 12
  and later, current Fedora); both packages declare it. On arm64 each was installed or run in a fresh
  container (the `.deb` on Ubuntu 22.04, Ubuntu 24.04 and Debian 12, the AppImage on Ubuntu
  22.04, the `.rpm` on Fedora 42) and passed the packaged smoke under a virtual X display,
  including a stand-in agent session that a SIGTERM to the app ended cleanly. The AppImage needs
  FUSE (`fuse3`) to mount, or `APPIMAGE_EXTRACT_AND_RUN=1`. Nobody has used them on a real Linux
  desktop: Wayland, GPU drivers, HiDPI and the on-screen look of native dialogs are unverified,
  and Linux x86_64 packages use the same recipe in the release workflow. See
  [release](docs/release.md#linux-packages) and the version's [verification record](audit/v0.2.3/README.md).
- The Rust app was verified with automated suites, browser walkthroughs and a QA pass on the Rust
  headless host, and an adversarial review whose fixes each carry a regression test. The release
  bundle was launched only by the packaged smoke and a window check; the last native
  walkthrough by hand is the [26 September audit](audit/v1-readiness/README.md), which predates
  the 0.2 releases.
- The live-model evaluation is one run per cell (Claude Code and Codex CLI on four tasks), so
  its outcomes are observations, not rates. See the [V1 readiness record](audit/v1/README.md).
- The agent runs with your operating-system permissions. Omen Flow's review gate controls what
  enters the engineering baseline; it is not a sandbox. See [security](SECURITY.md).
- Research browsing (an isolated webview reading public pages) exists only in the desktop app.
- STEP export (**Export STEP** in a part's view, `cad_export` for agents) has exact surfaces only
  with the optional converter and only for what it rebuilds: `minkowski()`, `resize()`, a
  chamfered `offset()`, a twisted or scaled `linear_extrude`, `roof()` and `projection()` make a
  faceted file, and a `hull()` of anything but upright cylinders or circles is planar facets. A
  part with a surface too thin for the comparison's probes is faceted too, with that reason. A
  faceted file is the render's triangles merged into planar faces (median 1.3 MB, at most 7.5 MB
  on the 49-part CADGenBench corpus); large ones are slow to open in some CAD tools.
- Project archives carry the record, objects and working files, not readable per-artifact views;
  agent call history stays out of archives.

Current status and verification numbers: [0.2.3 verification record](audit/v0.2.3/README.md).
Releases 0.2.0–0.2.3 were first published as 1.0.0–1.0.3 and renumbered on 21 October 2026,
because Omen Flow is a preview, not a 1.0; the earlier records keep the original numbers.
Earlier records: [V1 readiness record](audit/v1/README.md), [`audit/`](audit/); [build status](BUILD_STATUS.md) says where the Electron-era
ledger went.

## License

Omen Flow is licensed under the Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
The app includes third-party crates, packages and fonts under their own permissive licences,
listed with their copyright notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
shipped inside every release package. OpenSCAD, Python with OCP (OpenCASCADE, LGPL) for exact
STEP export, and agent CLIs are installed separately and keep their own licences.
