# STARK build ledger

Updated continuously during implementation. This file reflects the actual
state of the repository, not the plan.

## Completed systems

- Repository skeleton: pnpm workspace (hoisted linker), TypeScript strict,
  ESLint/Prettier, vitest root config, Apache-2.0 + community docs.

## Partially completed systems

- (in progress) `packages/contracts`

## Unresolved implementation problems

- No Rust toolchain on this machine: `native/stark-bridge` source will be
  written per plan, but the compiled helper cannot be produced here. A Node
  `stark` CLI shim provides the same `call`/`mcp` commands in development.
  Deviation recorded: bridge ships as TS now; Rust helper compiles where
  cargo exists (CI).
- No OpenSCAD installed locally: the adapter implements the full
  detect/probe/render/inspect contract; real-render tests are gated on
  executable presence (fixture executable used otherwise).
- No Windows machine: `Setup.exe` build + verification deferred to CI;
  code paths are written cross-platform (named pipe, ConPTY, .cmd shims).

## Golden-path status

Not yet established — skeleton phase.

## Failing tests

None yet.

## Platform verification

- macOS arm64 (dev): pending first package.
- Windows x64: not verifiable on this machine.

## Deviations from Plan.md

1. Rust bridge not compiled in this environment (no cargo). Node shim used
   for dev/test; Rust source kept under `native/stark-bridge`.

## Next highest-leverage work

- Contracts package (entities, ops, protocol), then storage + core.
