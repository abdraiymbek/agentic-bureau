# Omen Flow

Omen Flow is a local desktop engineering workspace. An existing agent CLI runs
in a native PTY; structured requirements, components, calculations, CAD, wiring,
and tests live in the project folder. Agents create drafts and proposals. A
human reviews and approves baseline changes.

The production desktop shell, domain dispatch, storage, agent host, MCP server,
and bridge are Rust. Tauri hosts the existing React renderer in the operating
system webview. React, Vite, and pnpm are build tools; the packaged app contains
neither Electron nor a Node runtime. The renderer implements the Lens design
system: a project flow, object focus between causal rails, one-at-a-time
decisions, and an agent composer wired to the real terminal.

Projects retain schema 1 at `.omenflow/state.sqlite` with the same object store
and bridge protocol v1. Existing `@omenflow` operation names and the
`omenflow call <op>` / `omenflow mcp` CLI remain the compatibility surface.

## Architecture

| Path                         | Role                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `apps/rust-desktop/`         | Tauri shell, commands, isolated research webview            |
| `apps/desktop/src/renderer/` | Lens renderer: zoom levels, primitives, flow map, viewport  |
| `crates/contracts/`          | Operation registry, input validation, wire envelopes        |
| `crates/storage/`            | SQLite schema 1, FTS5, object store, path guards            |
| `crates/core/`               | Revisions, human review, graph, CAD, calculations, archives |
| `crates/agent-host/`         | PTY, adapters, local bridge server, MCP dispatch            |
| `native/omenflow-bridge/`    | Bundled Rust `omenflow` CLI and MCP client                  |
| `design-system/`             | Lens tokens, fonts, brand assets, and UI specification      |

The former Electron main/preload/utility and TypeScript domain packages remain
in the repository as migration references and compatibility test oracles; they
are not included in the Tauri bundle. New privileged behavior belongs in Rust.
Read [the design specification](design-system/design.md) before changing the UI.

## Develop and verify

```sh
pnpm install --frozen-lockfile
pnpm dev                 # Tauri Rust shell + Vite renderer
cargo test --workspace   # Rust domain, storage, bridge, PTY, MCP
pnpm typecheck           # renderer and legacy compatibility sources
pnpm test                # legacy TypeScript behavior oracle
pnpm make                # release Rust app and unsigned local installer
pnpm smoke:packaged      # launch bundle and probe its authenticated bridge boundary
```

`pnpm make` produces `target/release/bundle/macos/Omen Flow.app` and an unsigned
DMG on macOS. `pnpm release:macos` signs and notarizes with Apple credentials;
see [release instructions](docs/release.md). The project needs OpenSCAD
installed for source rendering. The engine is not bundled.

`pnpm design:preview` still serves a disposable populated UI for design review.
It is a preview, not a native agent execution test. `pnpm fixture:rover` and
`pnpm fixture:drone` build reference projects.

## Migration evidence and limits

The packaged Electron baseline and Rust after measurements are in
[`audit/rust-migration/`](audit/rust-migration/after/README.md). The Rust app
has been opened on a copied schema 1 fixture and its 99,852-triangle STL was
rendered in the existing viewport. The packaged PTY, `omenflow call`, and
research window were exercised locally. The `BUILD_STATUS.md` ledger and
`audit/release-v0.1/` describe the earlier Electron candidate; their release
qualification does not transfer to the Rust package.

Apple signing, notarization, clean-machine upgrade, and non-macOS acceptance
still require their respective environments. Current Rust tests and local
packaged smoke do not constitute public-release approval.
