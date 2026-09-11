# Contributing to STARK

STARK is a local-first desktop engineering workspace. Contributions are welcome.

## Getting started

See `docs/development.md` for toolchain requirements and the exact commands for
install, typecheck, test, dev launch, and packaging. The short version:

```sh
pnpm install
pnpm test          # domain tests (Node ABI native modules)
pnpm dev           # run the desktop app in dev mode
pnpm package       # produce an unsigned package
pnpm make          # produce platform installers
```

## Ground rules

- `Plan.md`-derived behavior is authoritative; the build ledger `BUILD_STATUS.md`
  tracks what actually works. Keep it honest.
- Never commit secrets, signing material, or user project data.
- Keep the artifact / revision / proposal / decision model distinct. Do not
  collapse engineering history into mutable records.
- Agents must not be able to approve their own proposals. This is a core
  product invariant — test it.
- Every visible control must work, have a real empty state, or explain its
  missing prerequisite.

## License

By contributing you agree your contributions are licensed under Apache-2.0.
