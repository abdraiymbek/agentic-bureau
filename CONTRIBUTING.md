# Contributing to Omen Flow

Omen Flow is a local desktop engineering workspace: an agent CLI drafts, a person decides.
Contributions are welcome. Start with [development](docs/development.md) for the toolchain and
commands, and [architecture](docs/architecture.md) for where things live. Before touching the
interface, read [AGENTS.md](AGENTS.md) and [the design specification](design-system/design.md).

## How a change flows

1. **Contracts first.** An operation, a field or an error shape starts in
   `packages/contracts/src/ops.ts` (zod), with its description, and for agent tools its `tier`,
   `pack`, `summary` and `example`. Changes are additive: existing operation names, the
   `omenflow call <op>` / `omenflow mcp` surface and existing fields keep working; new fields are
   optional. Then run `pnpm contracts:export` and commit `crates/contracts/registry.json` with
   it; `pnpm contracts:check` fails when they drift. Tool-listing sizes have budgets
   (`packages/contracts/src/ops.test.ts` and the listing test in
   `crates/agent-host/src/present.rs`); a change that crosses one is a decision to record, not
   a number to raise quietly.
2. **Rust.** Domain behaviour goes in `crates/core`, reached through `dispatch` like everything
   else; host behaviour (terminals, adapters, the bridge, what agents are shown) in
   `crates/agent-host`. Mutations run in one transaction (`txn::atomically`), record events
   through the event helpers (never a raw `INSERT INTO event`), and fail with a
   `ContractError` that has a `repair` sentence and, for validation, every issue in
   `details.issues`. Agent-facing text — descriptions, playbooks in
   `crates/agent-host/guides/` (at most 2,400 characters, ending “then call work_status”) —
   names tools by their underscore names. Tests sit beside the code; tests that need OpenSCAD
   use `cad::testing::engine_available`, which fails rather than silently skipping.
3. **Storage stays schema 1.** Only additive, lazily created tables, indexes and nullable or
   defaulted columns, new `meta` keys, new event types and sidecar files under `.omenflow/`. No
   version bump, rename or constraint change. A project must stay openable by earlier builds.
4. **The legacy TypeScript packages** are a behaviour oracle, not a place for new features.
   When an operation or input exists only in Rust, list it in `RUST_HOST_OPS` or
   `assertLegacyInputs` (`packages/core/src/dispatch.ts`) so the oracle refuses it with a typed
   error instead of ignoring it; an operation the oracle serves only for a person goes in
   `RUST_HOST_AGENT_OPS`, and its legacy MCP server does not list either kind.
5. **Host-level behaviour** gets a case in `tests/conformance/` (run with
   `pnpm test:conformance`), written from what the host actually returns.
6. **The renderer** (`apps/desktop/src/renderer/`) follows the Lens model: add a stage or a lens
   (one entry in `project/lenses.ts`), never a page or a dashboard. Use the tokens in
   `design-system/tokens.css`, the primitives in `ui/kit.tsx`, and the stylesheet of the surface
   you change in `styles/`. Import only types and the dependency-free entry points
   `@omenflow/contracts/format` and `@omenflow/contracts/chat` from the contracts package, never
   its runtime barrel. Renderer tests live in `tests/frontend/`. A new reusable pattern goes into
   the Design system view and the specification; check both themes at 1024 × 700 and
   1440 × 900 in `pnpm design:preview`.

## Before you send it

```sh
pnpm contracts:check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:conformance
```

These are what CI runs (`.github/workflows/ci.yml`), plus packaging on macOS. Say in the change
what you verified and how, and what you did not.

## Ground rules

- Engineering integrity outranks polish. Quantities keep their units, unknown stays unknown
  with its reason, and review, freshness, evidence and execution stay separate. Never fabricate
  tool success, agent activity, data or a “verified” state; label anything not verified.
- Agents must not be able to approve, accept or revert anything. That is a product invariant;
  test it when you touch the capability path.
- Keep the artifact, revision, proposal and decision model distinct. History is immutable.
- Every visible control works, has a real empty state, or explains its missing prerequisite.
- Never weaken or delete a test to make it pass. If a test encodes behaviour you are changing
  on purpose, change the test and say why.
- Never commit secrets, signing material or someone's project data.
- No new runtime dependency without a clear reason, stated in the change.

## License

By contributing you agree that your contributions are licensed under Apache-2.0.
