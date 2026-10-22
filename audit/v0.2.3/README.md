# Omen Flow 0.2.3 verification record

Date: 21 October 2026 (America/Chicago). Status: **published; supported-platform release gates passed**.

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

Package and publication checks:

| Check                                                             | Result                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS arm64 build, bundle metadata, signatures and packaged smoke | passed; 0.2.3, `app.omenflow.desktop`, arm64, minimum macOS 13.3; DMG verified with `hdiutil verify`, mounted read-only; ad hoc app and helper signatures valid; packaged smoke passed from the mounted path                                                                                                                                                             |
| Linux arm64 build, declared floors and packaged smoke             | passed in about 600 s with `--skip-tests` (the suites ran on the host, above); packages, metadata (version 0.2.3) and floors; .deb on Ubuntu 22.04/24.04 and Debian 12, AppImage on Ubuntu 22.04 without GTK/WebKitGTK, .rpm on Fedora 42, all fresh Xvfb containers. Its sources were copied before this record was added; every build input matches the release commit |
| CI on the release commit                                          | passed all eight supported-platform gates ([run 39707296819](https://github.com/abdraiymbek/omen-flow/actions/runs/39707296819)); the experimental Windows job failed during legacy `better-sqlite3` installation, as in 1.0.1–1.0.3, and is not a release gate                                                                                                          |
| Linux x86_64 release workflow and packaged smoke                  | passed ([run 39707326620](https://github.com/abdraiymbek/omen-flow/actions/runs/39707326620)); it ran on the draft release while the local packages built, so it wrote the first `SHA256SUMS` and the local entries were merged into it with `scripts/merge-checksums.mjs`                                                                                               |
| Final asset names, checksums and publication                      | passed; 8 assets (7 packages and SHA256SUMS), all re-downloaded into a fresh folder; each matched GitHub's SHA-256 digest and size and `shasum -a 256 -c SHA256SUMS`; names match the manifest exactly                                                                                                                                                                   |

## Release artifacts

Release: [v0.2.3](https://github.com/abdraiymbek/omen-flow/releases/tag/v0.2.3), published 2026-10-22T02:00:35Z, latest stable release.
Tag `v0.2.3` (annotated, “Omen Flow 0.2.3”) points at `c1b21fac66667b8d0fab6ab57d177d2d2e0949eb`
(“Renumber the release line to 0.2.3”), the commit CI ran on.
Commit author/committer, tagger and release author: **abdraiymbek** (`abraiymbek@gmail.com` for Git).

The macOS DMG and the arm64 Linux packages were built from that commit's tree on this Mac; the
x86_64 packages were built by the release workflow from the tag. [SHA256SUMS](SHA256SUMS) and
[assets.json](assets.json) preserve the published hashes and sizes. The limits above remain: no
notarization, native manual walkthrough, reduced-motion or VoiceOver check, clean-machine macOS
installation or upgrade, or physical Linux desktop use is claimed.

## Withdrawn releases

After 0.2.3 was published, the GitHub releases and tags `v1.0.0`–`v1.0.3` were deleted. Their
published notes are kept beside their records ([1.0.0](../v1/release-1.0.0-notes.md),
[1.0.1](../v1.0.1/release-notes.md), [1.0.2](../v1.0.2/release-notes.md),
[1.0.3](../v1.0.3/release-notes.md)), with the commits their tags pointed at, and their checksums
in each record's `SHA256SUMS` ([1.0.0](../v1/release-1.0.0-SHA256SUMS)). Every 1.0.x asset showed
one download per file on GitHub (two or three for some DMGs and `SHA256SUMS`), consistent with the
release checks' own re-downloads.
