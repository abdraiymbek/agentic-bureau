# Agentic Bureau 0.2.5 verification record

Date: 27 October 2026 (America/Chicago). Status: **published; supported-platform release gates passed**.

0.2.5 is the first release as Agentic Bureau (Bureau in the app, the CLI and the docs) and the
first since 0.2.3. It carries the changes prepared as 0.2.4 on 22 October and never published:
their behaviour, verification, live checks, STEP corpus and benchmark measurements are in the
[0.2.4 record](../v0.2.4/README.md) and its [measurements](../v0.2.4/measurements.md). This
record covers what came after: the rename and redesign, and what packaging them found.

## Changes since 0.2.4

| Change                         | Intended everyday behavior                                                                                                                                                                                                                                                                                                                          | Verification                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Omen Flow is Agentic Bureau | The app, window, CLI, docs and conversation say Bureau; the licence, notices and publisher say Agentic Bureau. Packages `@bureau/*`, crates `bureau-*`, the helper `bureau`, `bureau-host`, the MCP server `bureau`, `BUREAU_*` variables and the identifier `app.agenticbureau.desktop`. Projects, archives, guide blocks and settings carry over. | storage adoption, archive import, guide takeover and settings carry-over tests; [design verification](../../design-system/verification.md) |
| 2. A new interface             | The pixel mark, Mona Sans and JetBrains Mono, Bureau's own icons, a sidebar beside one sheet in place of the activity bar and title bar, and Dark and Light themes, on every surface including the launcher and introduction.                                                                                                                       | design preview in both themes and the narrow layout; contrast test; native renders below                                                   |
| 3. Section order               | A section lists copies of one feature by position, so `cad_view` and checks read the same on every platform (the order followed the mesh's triangle order, and the slotted-plate test failed on Linux CI, also on the 0.2.4 commit).                                                                                                                | regression test that fails without the fix; Linux CI                                                                                       |
| 4. Linux packages              | The packages are `bureau` (Tauri names them after the app), with the command `agentic-bureau` and their documents in `/usr/share/doc/bureau`.                                                                                                                                                                                                       | package metadata step; installed files in each container                                                                                   |
| 5. The app icon                | The supplied dark tile edge to edge, with no added margin, for macOS, Windows and Linux.                                                                                                                                                                                                                                                            | icons looked at; the bundle carries the regenerated `icon.icns`                                                                            |

## Compatibility and limits

- Application, workspace package and helper versions are 0.2.5. The bundle identifier is
  `app.agenticbureau.desktop` (it was `app.omenflow.desktop`) and the Linux packages are
  `bureau`, with the `agentic-bureau` command (they were `omen-flow`), so neither replaces an Omen
  Flow install. Bureau reads the Omen Flow settings folder on first launch; what the webview kept
  (theme, folded rails, unsent drafts, the open conversation) starts fresh once. Conversations
  are part of the project and are kept.
- Project storage remains schema 1. Bureau renames a project's `.omenflow` and
  `omenflow.project.json` to `.bureau` and `bureau.project.json` when it opens it; the marker
  keeps `"format": "omenflow-project"`, and recorded `omenflow-*` engine, checker and format
  identifiers stay as written. New calculations record `bureau-calc/2`.
- The helper is now `bureau`: `bureau call` and `bureau mcp` replace `omenflow call` and
  `omenflow mcp` with the same operations, and the MCP server agents get is named `bureau`. An
  agent configured by hand with the old helper needs the new path.
- Going back to 0.2.3 needs the project folder and marker renamed back, and is then lossy as the
  [0.2.4 record](../v0.2.4/README.md#compatibility-and-limits) describes (see
  [going back to 0.2.3](../../docs/project-format.md#going-back-to-023)).
- Everything else the 0.2.4 record lists under compatibility and limits still holds: listing
  budgets, exact STEP's separate Python, Codex picture replies read from source, agents never
  approving a baseline.
- The macOS app is ad hoc signed and is not notarized. OpenSCAD and agent CLIs are installed
  separately. Automated and packaged smoke results do not establish a native manual walkthrough,
  a clean-machine installation, an upgrade over an installed Omen Flow, reduced motion,
  VoiceOver, or use on a real Linux desktop.
- The experimental Windows package job fails to install `better-sqlite3` on the runner (no Visual
  Studio found), as it did on the 0.2.4 commit; Windows is not a release target.
- The standalone `videos/` package is outside this release; the films still show the Omen Flow
  brand.

## Final verification

Local candidate checks from [the release procedure](../../docs/release.md#local-candidate), on
27 October 2026 on macOS 27 arm64 with OpenSCAD 2026.09.18, with the packages built from
`1b10780` (`Prepare Agentic Bureau 0.2.5`):

| Check                                                             | Result                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review            | passed; workspace/app/helper 0.2.5 in the eight manifests, both Cargo versions and `tauri.conf.json`; the lockfiles change only the seven local crates                                                                                                                                                                                |
| Generated contracts and third-party notices                       | passed                                                                                                                                                                                                                                                                                                                                |
| TypeScript typecheck, lint and formatting                         | passed (lint: 0 errors)                                                                                                                                                                                                                                                                                                               |
| JavaScript and renderer suites, including engine cases            | 1129 passed across 110 files with real OpenSCAD (`BUREAU_OPENSCAD_E2E=1`); no skipped tests                                                                                                                                                                                                                                           |
| Rust formatting, clippy and workspace suites with OpenSCAD        | passed; 823 passed, 1 ignored                                                                                                                                                                                                                                                                                                         |
| macOS arm64 build, bundle metadata, signatures and packaged smoke | passed; 0.2.5, `app.agenticbureau.desktop`, `Bureau`, macOS 13.3 or later; DMG (10,929,183 bytes) verified with `hdiutil verify` and mounted read-only, with `INSTALL.txt` linking the renamed repository; ad hoc app and helper signatures valid; packaged smoke passed from the mounted path                                        |
| Linux arm64 build, declared floors and packaged smoke             | passed in 511 s with `--skip-tests` (32 steps); packages `bureau` 0.2.5 (.deb 12,385,864 bytes, .rpm 12,386,207, AppImage 87,697,928), command `/usr/bin/agentic-bureau`, menu entry `Bureau`; .deb on Ubuntu 22.04/24.04 and Debian 12, AppImage on Ubuntu 22.04 without GTK/WebKitGTK, .rpm on Fedora 42, all fresh Xvfb containers |
| Native renders                                                    | on the renamed tree before the version bump, the macOS app started from its bundle with an isolated data folder pictured its own window (the introduction, then the launcher), and every Linux package smoke pictured the introduction ([design verification](../../design-system/verification.md))                                   |

Not run again for 0.2.5: the STEP end-to-end tests with OCP and the live agent checks, which the
0.2.4 record holds. CI on the release commit, the x86_64 release workflow and the re-downloaded
assets are recorded [below](#release-artifacts).

## Release artifacts

Release: [v0.2.5](https://github.com/abdraiymbek/agentic-bureau/releases/tag/v0.2.5), published
2026-10-28T01:05:23Z, latest stable release. Tag `v0.2.5` (annotated, “Agentic Bureau 0.2.5”)
points at `51f78644f904940f4541ea43a70fd1b71f572d2b` (“Prepare Agentic Bureau 0.2.5 (#5)”), the
merge of the release branch, which differs from `1b10780` only in this record. Tagger and release
author: **abdraiymbek**.

- CI on the release commit ([run 40611147498](https://github.com/abdraiymbek/agentic-bureau/actions/runs/40611147498)):
  every job passed (contracts and renderer, both Rust workspaces, the helper, conformance and
  headless smoke, the legacy CAD evaluator, the macOS arm64 and Linux x86_64 packages with their
  packaged smoke) except the experimental Windows package, as above.
- The Release Linux x86_64 workflow
  ([run 40611204356](https://github.com/abdraiymbek/agentic-bureau/actions/runs/40611204356))
  built and smoke-tested the x86_64 packages from the tag and added them to `SHA256SUMS`.
- The macOS DMG and the arm64 Linux packages were built on this Mac (above). All eight assets were
  downloaded again into a fresh folder: every expected file was present, all seven checksums
  verified, and the four local packages matched the built files byte for byte.

[SHA256SUMS](SHA256SUMS) and [assets.json](assets.json) preserve the published hashes and sizes.
The limits above remain: no notarization, native manual walkthrough, reduced-motion or VoiceOver
check, clean-machine macOS installation or upgrade over Omen Flow, or physical Linux desktop use
is claimed. The draft release v0.2.4 keeps the Omen Flow packages and is not published.
