# Agentic Bureau 0.2.5 verification record

Date: 27 October 2026 (America/Chicago). Status: **release candidate; not published**.

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

FINAL_VERIFICATION_PENDING

## Release artifacts

Not published yet.
