# Omen Flow 0.2.3 verification record

Date: 21 October 2026 (America/Chicago). Status: **candidate; local checks passed, packages and
publication pending**.

This record covers release 0.2.3. Omen Flow is a preview, so its version line was renumbered
below 1.0: releases 1.0.0–1.0.3 became 0.2.0–0.2.3, and the 1.0.x releases are withdrawn. 0.2.3
is the 1.0.3 code rebuilt with the new number; the earlier three builds are not republished. The
1.0.3 changes and their verification are in the [1.0.3 record](../v1.0.3/README.md); its
packages and checksums do not qualify this build.

## Changes

| Change                 | Intended everyday behavior                                                                                                                                                                       | Verification                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| 1. The version number  | Application, workspace package and helper versions are 0.2.3 (the root and seven workspace manifests, the workspace and helper Cargo versions, both lockfiles' local crates, `tauri.conf.json`). | version consistency review below |
| 2. Documents           | The README, release procedure and build status name 0.2.3 and explain the renumbering; the 1.0.x records keep their numbers and say they were withdrawn.                                         | review                           |
| 3. No behaviour change | No source, contract, storage or host behaviour changed. The app reports the new number only where it already reported its version (the MCP server's `serverInfo` and `app.diagnostics`).         | by construction; suites below    |

## Compatibility and limits

- The bundle identifier remains `app.omenflow.desktop`, so settings carry over. Project storage
  remains schema 1, and opening read-only depends on the schema number, not the app version, so
  projects saved by 1.0.x open as before. Existing `@omenflow` APIs, `omenflow call` and
  `omenflow mcp` remain supported.
- Package managers see 0.2.3 as older than 1.0.3: on Linux a 1.0.x package must be removed
  before installing 0.2.3 (or installed with `dnf downgrade` / `apt install --allow-downgrades`).
  Dragging the macOS app into Applications replaces it regardless of version.
- The macOS app is ad hoc signed and is not notarized. OpenSCAD and agent CLIs are installed
  separately.
- Automated and packaged smoke results do not establish a native manual walkthrough, a
  clean-machine installation, an upgrade, reduced motion, VoiceOver, or use on a real Linux
  desktop.

## Final verification

Local candidate checks from [the release procedure](../../docs/release.md#local-candidate), on the
release commit's tree on macOS arm64 with OpenSCAD:

| Check                                                  | Result                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review | passed; workspace/app/helper 0.2.3; lockfiles change only local crate versions; no new dependencies |
| Generated contracts and third-party notices            | passed                                                                                              |
| TypeScript typecheck and formatting                    | passed                                                                                              |
| JavaScript and renderer suites, including engine cases | 1059 passed across 106 files with real OpenSCAD; no skipped tests                                   |
| Rust formatting                                        | passed                                                                                              |
| Rust workspace suites with OpenSCAD                    | 599 passed, 1 ignored; the ignored real-helper case passed separately                               |
| Helper tests                                           | 13 passed                                                                                           |
| Rust host conformance suites                           | 63 passed across 8 files                                                                            |
| Headless helper smoke                                  | passed read, agent draft and capability refusal                                                     |
| Lint and clippy                                        | not run locally, since no source changed; left to CI on the release commit (below)                  |
