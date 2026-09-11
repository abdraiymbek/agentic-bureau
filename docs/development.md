# Development

## Requirements

- Node ≥ 20, pnpm 9
- For packaging: platform build tools (Xcode CLT on macOS, MSVC on Windows)
- Optional: OpenSCAD (real CAD path), Codex CLI / Claude Code (agents), Rust
  (native bridge helper)

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace deps (hoisted linker for Electron packaging) |
| `pnpm test` | Domain tests under Node ABI (`vitest run`) |
| `pnpm rebuild:node` | Rebuild better-sqlite3/node-pty for Node ABI |
| `pnpm rebuild:electron` | Rebuild natives for the Electron ABI |
| `pnpm dev` | Run the desktop app (Electron Forge + Vite) |
| `pnpm package` | Unsigned packaged app under `apps/desktop/out` |
| `pnpm make` | Platform installers (dmg on macOS, Squirrel on Windows) |
| `pnpm typecheck` / `pnpm lint` | Static checks |

## Native module ABI

`better-sqlite3` and `node-pty` are compiled for one ABI at a time. Domain
tests run under Node (`pnpm rebuild:node`); the desktop app needs the Electron
ABI (`pnpm rebuild:electron`). Switch when changing contexts.

## Layout

See `docs/architecture.md`. Domain logic lives in `packages/`; the Electron
app is a thin host over `@stark/core`.
