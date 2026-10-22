# Omen Flow 1.0.2 verification record

> **Withdrawn and renumbered.** On 21 October 2026 the 1.0.x releases were removed and the version line renumbered 0.2.x, because Omen Flow is a preview, not a 1.0. 1.0.2 became 0.2.2; this build was not republished. The release and download links below no longer resolve; the checks and checksums describe the 1.0.2 files as they were published.

Date: 20 October 2026 (America/Chicago). Status: **published; supported-platform release gates passed**.

This record covers release 1.0.2. Earlier test counts and packages do not qualify this build;
1.0.1 evidence remains in the [1.0.1 record](../v1.0.1/README.md).

## Changes

| Change                                | Intended everyday behavior                                                                                                                                                                                                                                                     | Verification                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1. Conversation pane                  | The Agent tab, floating window and dock show a conversation beside the terminal. Codex CLI or Claude Code runs headless once per message; its text appears as it arrives; it can present a part, a record, quantities, an illustrative chart, choices and human review inline. | automated regression and preview review passed |
| 2. Prepare → Send                     | Editing a card's values attaches the exact literal values, units, artifact and revision to a readable request. Only Send runs the agent; a stale revision is refused.                                                                                                          | automated regression and real render passed    |
| 3. One agent per project              | A conversation send is refused while an agent terminal runs, and a terminal start while a response runs (`BUSY`); each pane offers to stop the other.                                                                                                                          | host, conformance and preview checks passed    |
| 4. Ask follows the pane               | Every “Ask agent” entry point drafts into the conversation's composer or pastes into the terminal, by the active pane; nothing is sent for the person.                                                                                                                         | automated regression passed                    |
| 5. Conversation updates from the host | The host announces each change to a project's conversation record (`chat` event); the pane reads the record on it instead of polling.                                                                                                                                          | automated regression and preview review passed |

## Compatibility and limits

- Application, workspace package and helper versions are 1.0.2. The bundle identifier remains
  `app.omenflow.desktop`.
- Project storage remains schema 1. Conversations are kept additively in
  `.omenflow/chat/conversations.json`; project archives do not include them. The five `chat.*`
  operations are additive; existing `@omenflow` APIs, `omenflow call` and `omenflow mcp` remain
  supported.
- Terminal agents keep their behaviour, including `ui.open_artifact` and `ui.request_review`
  moving the workspace. Only a conversation run's requests become cards.
- Charts an agent presents are illustrative, never evidence. Agents cannot approve, accept or
  revert a person's baseline.
- The macOS app is ad hoc signed and is not notarized. OpenSCAD and agent CLIs are installed
  separately.
- Automated, preview and packaged smoke results do not establish a native manual walkthrough,
  a clean-machine installation, an upgrade, or use on a real Linux desktop.

## Final verification

Local candidate checks from [the release procedure](../../docs/release.md#local-candidate), on the
release commit's tree on macOS arm64 with OpenSCAD:

| Check                                                  | Result                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review | passed; workspace/app/helper 1.0.2; lockfiles change only local crate versions; new renderer dependencies streamdown 2.7.1, recharts 3.10.1 and react-is 18.3.1 with notices |
| Generated contracts and third-party notices            | passed                                                                                                                                                                       |
| TypeScript typecheck, lint and formatting              | passed; lint 0 errors, 124 warnings (unchanged)                                                                                                                              |
| JavaScript and renderer suites, including engine cases | 1046 passed across 105 files with real OpenSCAD; no skipped tests                                                                                                            |
| Rust formatting and clippy                             | passed with warnings denied                                                                                                                                                  |
| Rust workspace suites with OpenSCAD                    | 599 passed, 1 ignored; the ignored real-helper case passed separately                                                                                                        |
| Helper tests                                           | 13 passed                                                                                                                                                                    |
| Rust host conformance suites                           | 63 passed across 8 files, including the one-agent gate, `chat` events, and an exact-input render through the CLI bridge                                                      |
| Headless helper smoke                                  | passed read, agent draft and capability refusal                                                                                                                              |
| Renderer design-preview review                         | passed Graphite and Paper at 1440×900 and 1024×700 ([conversation pane](../../design-system/verification.md))                                                                |
| Real agent run in the preview                          | one Claude Code run read a part and presented its card; it changed nothing                                                                                                   |

Package and publication checks:

| Check                                                             | Result                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64 build, bundle metadata, signatures and packaged smoke | passed; 1.0.2, `app.omenflow.desktop`, arm64, minimum macOS 13.3; DMG verified with `hdiutil verify`, mounted read-only; ad hoc app and helper signatures valid; packaged smoke passed from the mounted path                                                                                                                                            |
| Linux arm64 build, tests, declared floors and packaged smoke      | passed in 694 s; in-container Rust workspace 596 passed, 1 ignored; helper tests and real-helper round trip; conformance 63 passed; floors app `GLIBC_2.35`, helper `GLIBC_2.34`, AppImage at most `GLIBC_2.35`; .deb on Ubuntu 22.04/24.04 and Debian 12, AppImage on Ubuntu 22.04 without GTK/WebKitGTK, .rpm on Fedora 42, all fresh Xvfb containers |
| CI on the release commit                                          | passed all eight supported-platform gates ([run 39528399368](https://github.com/abdraiymbek/omen-flow/actions/runs/39528399368)); the experimental Windows job failed during legacy `better-sqlite3` installation, as in 1.0.1, and is not a release gate                                                                                               |
| Linux x86_64 release workflow and packaged smoke                  | passed ([run 39529932596](https://github.com/abdraiymbek/omen-flow/actions/runs/39529932596))                                                                                                                                                                                                                                                           |
| Final asset names, checksums and publication                      | passed; 8 assets (7 packages and SHA256SUMS), all re-downloaded; each matched GitHub's SHA-256 digest and `shasum -a 256 -c SHA256SUMS`; names match the manifest exactly                                                                                                                                                                               |

## Release artifacts

Release: [v1.0.2](https://github.com/abdraiymbek/omen-flow/releases/tag/v1.0.2), published 2026-10-21T02:07:07Z, latest stable release.
Tag `v1.0.2` (annotated, “Omen Flow 1.0.2”) points at `c6c4d8ef735c7b411b8e8a8870ee67276db6e787`.
Commit author/committer and release author: **abdraiymbek** (`abraiymbek@gmail.com` for Git).

The first CI run on `78b0b9e` (“Prepare Omen Flow 1.0.2”) failed its conformance job: the new
conversation cases need the `omenflow` helper and OpenSCAD, which that job did not provide. The tagged
commit `c6c4d8e` changes only `.github/workflows/ci.yml` to build the helper first and install the
pinned OpenSCAD 2021.01; `git diff --stat 78b0b9e c6c4d8e` lists that file alone. The macOS DMG and
the arm64 Linux packages were built from `78b0b9e`, whose application sources are identical to the
tag's; the x86_64 packages were built by the release workflow from the tag.

[SHA256SUMS](SHA256SUMS) and [assets.json](assets.json) preserve the published hashes and sizes. The
limits above remain: no notarization, native manual walkthrough of the conversation pane,
clean-machine macOS installation or upgrade, real Codex run, or physical Linux desktop use is claimed.
