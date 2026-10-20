# Omen Flow 1.0.1 verification record

Date: 19 October 2026 (America/Chicago). Status: **release candidate; publication checks in progress**.

This record covers the 1.0.1 candidate after the project audit. Results below distinguish completed checks from publication work still in progress. Earlier test counts, packages and measurements do
not qualify this build; historical evidence remains in the [V1 record](../v1/README.md).

## Changes

| Change                                 | Intended everyday behavior                                                                                                                                                      | Verification                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1. Revision-parent index               | Large projects can find live revision heads without repeatedly scanning every revision. The index is created additively when opening an existing schema 1 project.              | automated regression passed |
| 2. Live view refresh                   | Object stages, Files, Parts, component offers and decision verification refresh when their underlying revisions or evidence change.                                             | automated regression passed |
| 3. Native close and quit               | Native close and quit requests consult the renderer's unsaved-edit guard before stopping an agent or destroying the workspace.                                                  | automated regression passed |
| 4. Revision-bound test observations    | An observation entered against a particular test revision is refused with a conflict when that revision moved, so the person can review it before retrying.                     | automated regression passed |
| 5. Terminal continuity and cleanup     | Stale session snapshots do not overwrite newer terminal state, a naturally exited agent's remaining process group is cleaned up, and older recorded activity remains reachable. | automated regression passed |
| 6. Mesh retention and visible geometry | Parsed meshes have a byte budget, and the geometry acceptance guard requires the revision actually drawn in the viewport.                                                       | automated regression passed |
| 7. Reachable revision history          | Summary pages make long histories navigable, including through MCP, while a revision can still be read in full.                                                                 | automated regression passed |
| 8. Omnibar content search              | Searching project content can open the exact matching revision, with clear context when it is outside the current baseline.                                                     | automated regression passed |
| 9. Faithful build packages             | BOM prices preserve pack quantities and extended costs; generated assembly, wiring and assumption documents describe all revisions included in the manifest.                    | automated regression passed |

Release preparation also replaces a rebuilt asset's old checksum while retaining checksum
entries for the other architectures. Its replacement-and-retention regression checks passed.

## Compatibility and limits

- Application, workspace package and helper versions are 1.0.1. The bundle identifier remains
  `app.omenflow.desktop`.
- Project storage remains schema 1. The revision index and contract fields are additive;
  existing `@omenflow` APIs, `omenflow call` and `omenflow mcp` remain supported.
- New history options and `test.record_result.expectedRevisionId` belong to the Rust host.
  The legacy TypeScript oracle refuses those inputs with a typed error.
- Agents cannot approve, accept or revert a person's baseline. Approval and engineering
  validity remain separate.
- The macOS candidate is ad hoc signed unless Developer ID signing and notarization are
  explicitly recorded below. OpenSCAD and agent CLIs are installed separately.
- Automated preview and packaged smoke results do not establish a native manual walkthrough,
  a clean-machine installation, an upgrade, or use on a real Linux desktop.
- The standalone `videos/` package is outside this release's version changes.

## Final verification

| Check                                                               | Result                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review              | passed; workspace/app/helper 1.0.1; no third-party resolution changes                                                                   |
| Generated contracts and third-party notices                         | passed                                                                                                                                  |
| TypeScript typecheck, lint and formatting                           | passed; lint 0 errors, 124 warnings                                                                                                     |
| JavaScript and renderer suites, including applicable engine cases   | 998 passed with real OpenSCAD; 2 subsequent navigation regressions passed (25 focused cases)                                            |
| Rust formatting and clippy                                          | passed with warnings denied; helper formatting and clippy passed                                                                        |
| Rust workspace suites with OpenSCAD                                 | 581 passed, 1 ignored; ignored real-helper case passed separately                                                                       |
| Helper tests and real-helper round trip                             | 13 helper tests and 1 real-helper round trip passed                                                                                     |
| Rust host conformance suites                                        | 55 passed across 5 files                                                                                                                |
| Headless helper smoke                                               | passed read, agent draft and capability refusal                                                                                         |
| Large-project performance measurement                               | 600 artifacts / 3000 revisions; 500-row summary p50 9.25 ms, p95 23.39 ms under concurrent package builds                               |
| Renderer design-preview review                                      | passed Paper and Graphite at 1440×900 and 1024×700; live offers, draft heads, Files, search revision, concurrent observation guard      |
| Native unsaved-close and quit validation                            | passed on isolated disposable project; requirement/test/CAD edits, repeated close, agent-consent cancel, confirmed quit and clean close |
| macOS arm64 build, bundle metadata, signatures and packaged smoke   | pending                                                                                                                                 |
| Linux arm64 packages, declared dependency floors and packaged smoke | pending                                                                                                                                 |
| Linux x86_64 release workflow and packaged smoke                    | pending                                                                                                                                 |
| Final asset names, checksums and release publication                | pending                                                                                                                                 |

## Artifacts and remaining work

Release commit, tag, workflow run, artifact sizes, hashes and outstanding limits: pending.

### Observed behavior

The disposable native walkthrough used a real Custom CLI PTY, without spending model credits.
Canceled close/quit retained a requirement target, test observation and CAD source; canceling
the later agent consent retained both edits and the running agent. Confirmed quit exited 0
and stopped the PTY process. Reopening showed the saved baseline and an idle agent.

The real Rust preview followed component draft r2→r3→r4 and supplier offers 1→2 without
reopening, refreshed a Files row r2→r3, and opened a content hit pinned to its matched draft.
A concurrent test procedure change retained typed observation text and showed the explicit
review action before recording. No human approval or engineering validity was fabricated.

Viewport context-loss and stale-frame acceptance are covered by automated guards; intentional
GPU context loss was not induced in the native walkthrough. Linux desktop checks below run
under Xvfb in disposable containers, not on physical Linux workstations.
