# Omen Flow 1.0.3 verification record

Date: 21 October 2026 (America/Chicago). Status: **candidate; package and publication checks follow the build**.

This record covers release 1.0.3. Earlier test counts and packages do not qualify this build;
1.0.2 evidence remains in the [1.0.2 record](../v1.0.2/README.md).

## Changes

| Change                            | Intended everyday behavior                                                                                                                                                                                                                                                  | Verification                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1. The introduction               | On first launch an introduction plays over the launcher: four acts on the rover's own map (arrive; see the whole; focus on one, with a live 3D camera tray; decide, where the person approves a proposal and the impact travels the recorded links), then five setup steps. | automated regression and preview review passed |
| 2. Setup that does the real thing | The steps detect the agent CLIs on this machine and remember the choice, probe OpenSCAD and let the person locate it, switch Graphite or Paper live, light the shortcuts as they are pressed, and say where projects and settings live.                                     | preview review with real detection passed      |
| 3. Replay and memory              | `Esc` skips at any point. The introduction is remembered as the version seen (`omen.intro`) and plays again from Settings → Appearance, the launcher's footer, `⌘K` (Introduction) and the catalogue; raising its version plays a reworked introduction for everyone.       | automated regression passed                    |
| 4. Nothing recorded               | The acts use fixture data in the renderer only; approving the demo proposal records nothing, and no `.omenflow` storage, contract or host behaviour changes.                                                                                                                | by construction; conformance suite unchanged   |

## Compatibility and limits

- Application, workspace package and helper versions are 1.0.3. The bundle identifier remains
  `app.omenflow.desktop`.
- Project storage remains schema 1; no operation, contract or host behaviour changed. Existing
  `@omenflow` APIs, `omenflow call` and `omenflow mcp` remain supported.
- The introduction's "seen" mark lives in the webview's own storage, like the theme, so a cleared
  webview storage plays it again; it never reads or writes a project.
- The macOS app is ad hoc signed and is not notarized. OpenSCAD and agent CLIs are installed
  separately.
- Automated, preview and packaged smoke results do not establish a native manual walkthrough,
  a clean-machine installation, an upgrade, reduced motion, VoiceOver, or use on a real Linux
  desktop.

## Final verification

Local candidate checks from [the release procedure](../../docs/release.md#local-candidate), on the
release commit's tree on macOS arm64 with OpenSCAD:

| Check                                                  | Result                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review | passed; workspace/app/helper 1.0.3; lockfiles change only local crate versions; no new dependencies                                |
| Generated contracts and third-party notices            | passed                                                                                                                             |
| TypeScript typecheck, lint and formatting              | passed; lint 0 errors, no warnings in changed files                                                                                |
| JavaScript and renderer suites, including engine cases | 1059 passed across 106 files with real OpenSCAD; no skipped tests                                                                  |
| Rust formatting and clippy                             | passed with warnings denied                                                                                                        |
| Rust workspace suites with OpenSCAD                    | 599 passed, 1 ignored; the ignored real-helper case passed separately                                                              |
| Helper tests                                           | 13 passed                                                                                                                          |
| Rust host conformance suites                           | 63 passed across 8 files                                                                                                           |
| Headless helper smoke                                  | passed read, agent draft and capability refusal                                                                                    |
| Renderer design-preview review                         | passed Graphite at 1440×900 and Paper at 1024×700 through every act and step ([introduction](../../design-system/verification.md)) |

Package and publication checks:

| Check                                                             | Result  |
| ----------------------------------------------------------------- | ------- |
| macOS arm64 build, bundle metadata, signatures and packaged smoke | PENDING |
| Linux arm64 build, tests, declared floors and packaged smoke      | PENDING |
| CI on the release commit                                          | PENDING |
| Linux x86_64 release workflow and packaged smoke                  | PENDING |
| Final asset names, checksums and publication                      | PENDING |

## Release artifacts

PENDING: filled in once the release is published.
