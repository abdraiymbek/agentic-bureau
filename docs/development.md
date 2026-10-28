# Development

## Requirements

- Node 24 (`.nvmrc`; `package.json` accepts 20 and later) and pnpm 9.15.9 (`packageManager`).
- The stable Rust toolchain with rustfmt and clippy (`rust-toolchain.toml`).
- OpenSCAD for the CAD engine. `cargo test --workspace` runs real renders and **fails** when
  OpenSCAD is missing, unless `BUREAU_ALLOW_MISSING_OPENSCAD=1` says to skip those tests.
  `OPENSCAD_PATH` names a specific executable. On macOS use the snapshot cask
  (`brew install --cask openscad@snapshot`); the Rust engine tests have been run with 2026.09.18
  only.
- macOS: Xcode command line tools (Tauri and the node-pty build). Linux (Debian, Ubuntu):
  `sudo sh scripts/linux/build-deps.sh` installs WebKitGTK and the other Tauri and node-pty
  requirements (on Linux the research screenshot comes from WebKitGTK, so no screen-capture
  libraries are needed); `node scripts/linux-package.mjs` builds, tests and runs the Linux
  packages in containers instead ([release](release.md#linux-packages)).
- Optional: a signed-in Codex CLI or Claude Code for real agent sessions.
- Optional: a Python with OCP for the exact STEP converter's opt-in tests (they never look for
  one on their own). Offline from the uv cache, for example:
  `uv venv --offline --python 3.12 /tmp/step-venv && uv pip install --offline --python /tmp/step-venv/bin/python cadquery-ocp-novtk==7.9.3.1.1`,
  then
  `BUREAU_STEP_E2E=1 BUREAU_PYTHON=/tmp/step-venv/bin/python cargo test -p bureau-core --lib --locked cad::step -- --nocapture`.

After a clean install on macOS run `pnpm rebuild:node`: node-pty's prebuilt `spawn-helper` is
unpacked without its executable bit, and the legacy PTY tests fail with `posix_spawnp failed`
until it is built from source.

## Commands

| Command                                                                                        | What it does                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                               | Installs the workspace (hoisted linker)                                                                                                        |
| `pnpm rebuild:node`                                                                            | Rebuilds node-pty from source (`scripts/rebuild-natives.mjs`)                                                                                  |
| `pnpm contracts:check`                                                                         | Fails when `crates/contracts/registry.json` differs from what `packages/contracts` exports                                                     |
| `pnpm contracts:export`                                                                        | Rewrites the registry and prints the compact, standard and full tool-listing sizes                                                             |
| `cargo test --workspace`                                                                       | Rust tests for contracts, storage, core, agent host, headless host and the desktop shell                                                       |
| `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --all -- --check` | Rust lint and format, as CI runs them                                                                                                          |
| `pnpm build:bridge`                                                                            | Release build of the `bureau` helper (`native/bureau-bridge`, its own Cargo workspace)                                                         |
| `cargo test -p bureau-agent-host -- --ignored`                                                 | The real-helper round trip (needs `pnpm build:bridge` first)                                                                                   |
| `pnpm test`                                                                                    | Vitest: the legacy TypeScript oracle (`packages/*`), `tests/*.test.ts`, the renderer tests in `tests/frontend/`, fixtures                      |
| `pnpm exec vitest run tests/frontend tests/terminal-restore.test.ts`                           | Only the renderer tests                                                                                                                        |
| `pnpm test:conformance`                                                                        | Type-checks `tests/conformance/`, builds `bureau-host`, and runs the corpus against it                                                         |
| `pnpm typecheck`                                                                               | Every workspace package (renderer included) and `evals/`                                                                                       |
| `pnpm lint`, `pnpm format:check`                                                               | ESLint and Prettier over the repository                                                                                                        |
| `pnpm --filter @bureau/desktop build:rust-ui`                                                  | The static renderer the Tauri bundle embeds (`apps/desktop/rust-dist/`)                                                                        |
| `pnpm smoke:headless`                                                                          | Starts `bureau-host`, then drives the helper with a real grant: usage, a refused token, a read, an agent draft, a refused approval, clean exit |
| `pnpm design:preview`                                                                          | The renderer on the Rust headless host with disposable fixture projects (below)                                                                |
| `pnpm fixture:rover <dir>`, `pnpm fixture:drone <dir>`                                         | Builds a reference project into an empty or new folder through the Rust host                                                                   |
| `pnpm dev`                                                                                     | `pnpm build:bridge`, then `tauri dev` (which starts the renderer's Vite server on 127.0.0.1:5174)                                              |
| `pnpm make`, `pnpm package`                                                                    | `pnpm build:bridge`, `build:rust-ui`, then `tauri build --no-sign`                                                                             |
| `pnpm smoke:packaged`                                                                          | Launches the built bundle with disposable state and runs the same helper checks against it                                                     |
| `pnpm release:macos`                                                                           | Signs, notarizes and staples the app and DMG; refuses without Apple credentials ([release](release.md))                                        |

`pnpm dev`, `pnpm make` and `pnpm smoke:packaged` open or build the native app; everything else
runs without a window.

## Running the headless host

```sh
cargo run -p bureau-headless --bin bureau-host -- --app-data "$(mktemp -d)"
```

It prints one line, `{"port", "token", "socketPath"}`, and serves until SIGINT, SIGTERM,
`POST /api/shutdown`, or (with `--exit-on-stdin-close`) the end of standard input. Every request
needs `Authorization: Bearer <token>` and a `Host` of `127.0.0.1:<port>` or `localhost:<port>`;
a request with an `Origin` header is refused. `--port` and `--token` fix them, `--cli` names the
helper (by default the one beside the binary, else the repository's release build).

The bridge socket is `<app-data>/run/bridge.sock`, and a socket path has a system length limit
of about 104 bytes, so keep the app-data path short (the system temporary folder works; a deep
scratch folder may not). The conformance client `tests/conformance/rust-core.ts` is the
reference for driving the host from TypeScript (`BUREAU_HOST_BIN` overrides the binary it
starts).

## Design preview

`pnpm design:preview` builds the host and the helper, starts the host on a temporary folder,
builds the rover and drone fixtures through it, and serves the renderer with Vite on
`http://127.0.0.1:5173`. It prints the address to open, `/?design-preview&key=<key>`, and the
disposable data folder (under the system temporary folder). The key is good for this run only:
the page trades it (a 303 redirect that drops it from the address) for an HttpOnly, same-site
cookie named for the port, and every preview endpoint answers 403 without that cookie or from
another origin. The page talks only to the preview server, which forwards to the host; the
host's token never reaches the page. Ctrl-C or SIGTERM stops the host and its terminals, and
the data folder is removed when the preview process exits, including after a failed start (a
process killed with SIGKILL cannot clean up).

- `BUREAU_PREVIEW_PORT` picks another port (useful when several previews run; each has its own
  cookie).
- Parameters: `screen=launcher|flow|parts|timeline|files|evidence|decide|agent|system`,
  `object=<artifact type>`, `theme=light|dark`, `console=open` (the agent window).
- Projects are created and opened only inside the preview folder; archive import is refused;
  exports land in the preview folder.
- Terminals and agent settings are off by default: `terminal.start`, `terminal.restart`,
  `connection.configure` and `connection.test` are refused with `PREVIEW`, because a Custom
  CLI runs any executable and Codex CLI and Claude Code spend model credits and may update
  themselves on first start. Start the preview with `BUREAU_PREVIEW_AGENTS=1` to run any of them
  in a real PTY from the Agent tab.
- Research browsing is not available (the headless host has no webview).

It is a design and behaviour preview on the real host, not a native acceptance test.

## Evaluations

- `pnpm eval:agent -- --out <dir>` ([`evals/agent/`](../evals/agent/README.md)) runs real agent
  CLIs against the release Rust headless host and judges the result from recorded project
  state, never from the model's account of it. It **spends model credits**, and nothing caps
  the spend: a Claude Code cell is bounded by 40 turns (`--max-turns`) and every cell by 10
  minutes (`--timeout-min`); a Claude Code cell's list-price cost is estimated afterwards from
  the dated table in `evals/agent/pricing.ts`, and Codex cells get no estimate. `--out` must be
  outside the repository. `--reference good` / `--reference bad` run scripted sessions
  with no model to check the judges.
- `pnpm eval:cad` and `pnpm eval:workflows` drive the legacy TypeScript stack with Codex CLI;
  their recorded results are in `evals/cad/results/`.

## Where things go

See [architecture](architecture.md) and [contributing](../CONTRIBUTING.md). Tests sit beside
the Rust code (`#[cfg(test)]` modules, `crates/*/tests`, `apps/headless/tests`), in
`tests/conformance/` for host-level behaviour, in `tests/frontend/` for the renderer, and in
`packages/*/src/*.test.ts` for the legacy oracle.

## Environment variables

| Variable                                       | Effect                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `BUREAU_APP_DATA_DIR`                          | The desktop app uses this data folder instead of the system one (isolated run, own instance lock) |
| `BUREAU_SMOKE_PROJECT`                         | With `BUREAU_APP_DATA_DIR`: create this project and write the agent grant for the smoke test      |
| `BUREAU_SMOKE_AGENT`                           | With `BUREAU_SMOKE_PROJECT`: start this executable as a Custom CLI session for the smoke test     |
| `BUREAU_SMOKE_SNAPSHOT`                        | With `BUREAU_SMOKE_PROJECT`: write a picture of the page when the smoke asks for one              |
| `BUREAU_ALLOW_MISSING_OPENSCAD=1`              | Rust engine tests skip instead of failing when OpenSCAD is absent                                 |
| `OPENSCAD_PATH`                                | The OpenSCAD executable to use when none is configured in Settings                                |
| `BUREAU_PYTHON`                                | The Python with OCP for exact STEP export when none is configured in Settings                     |
| `BUREAU_STEP_E2E=1`                            | With `BUREAU_PYTHON`: runs the Rust test of a real exact STEP export (fails without the Python)   |
| `BUREAU_STEP_CORPUS`                           | A folder of `<id>/project` folders: exports each part as STEP and prints one JSON line per part   |
| `BUREAU_OPENSCAD_E2E=1`                        | Runs the legacy TypeScript real-engine tests (`pnpm test`)                                        |
| `BUREAU_HOST_BIN`                              | The `bureau-host` binary the conformance client and fixtures start                                |
| `BUREAU_PREVIEW_PORT`, `BUREAU_PREVIEW_AGENTS` | Design preview port; `1` allows terminals and agent settings (any CLI) in it                      |
| `BUREAU_AGENTS_MD=off`                         | In a Custom CLI's environment: no Bureau block in the project's `AGENTS.md`                       |
