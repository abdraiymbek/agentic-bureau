# Agentic Bureau 0.2.4 release notes

Draft of the release body, 22 October 2026; the rename added 27 October 2026.

**Omen Flow is now Agentic Bureau**, Bureau for short in the app, the CLI and the docs. The app has
a new look: a pixel mark, a sidebar beside one sheet for the work, Mona Sans and JetBrains Mono, its
own icons, and Dark and Light themes. Your projects carry over: Bureau renames a project's
`.omenflow` folder and `omenflow.project.json` to `.bureau` and `bureau.project.json` the first
time it opens it, and reads your Omen Flow settings on first launch. The command-line helper is
now `bureau` (`bureau call`, `bureau mcp`) and the agents' MCP server is named `bureau`.

Bureau 0.2.4 also lets the agent see what it models, checks parts against what was asked, and
takes a shorter path on simple CAD work.

- **The agent can see its part.** `cad_view` draws the current part as an engineering sheet: front, top and right views at one scale with hidden edges dashed, an isometric view, and cross-sections. `image_view` shows a drawing whole with a grid, or zooms into a region. Agents compare their part with the drawing before they finish. Both are diagnostic, never verification.
- **Checks follow the request.** A CAD check lists each requested dimension or feature in the request's words, with the assertions that show it, and linked requirements add their own. An item nothing asserts keeps the part unverified, and the completion check names it.
- **A shorter CAD path.** A part is written and checked in one call, the CAD playbook is part of the agent's brief, and the purchased-parts playbook is now called "components". On the internal CAD suite with Claude Haiku 5.5 this took the median from 8 tool calls to 1 and cost per correct part down by about a fifth.
- **STEP export.** Export STEP on a part (and `cad_export` for agents, into `exports/`). With an optional Python that has OpenCASCADE, the part is rebuilt from its OpenSCAD source as exact surfaces and compared with the render; otherwise you get a faceted STEP, and the result says which.
- **Unfinished work is visible.** When a conversation response ends with blockers, it shows "Work not finished" with Continue, which resumes the same Claude Code conversation. Continuing automatically once is available in Settings and off by default.
- **Full model ids.** Claude Code now launches `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` or `claude-fable-5-1`. Before this release, the "Haiku" choice passed the alias `haiku`, which Claude Code 2.1.287 runs as Claude Haiku 4.5. Bureau never shows the CLI's cost figure; that CLI version prices Haiku 5.5 like a much larger model.

Benchmark notes (one run per task, details in the verification record): on 34 BenchCAD tasks, mean voxel IoU rose from 0.636 (two 0.2.3 runs) to 0.752, at about twice the cost per task, mostly image tokens. Drawings take longer (median 383 s against 234 s) because agents now read them at a legible size. The two v-pulley misses reported for the internal CAD suite on 21 October came from the evaluation judge, not the parts; with the judge fixed, every setup passes the suite.

Downloads include a macOS Apple Silicon DMG and Linux arm64/x86_64 Debian, RPM and AppImage packages. Verify downloads with SHA256SUMS.

The macOS app is ad hoc signed and is not notarized. Requires macOS 13.3 or later. OpenSCAD and agent CLIs are installed separately; exact STEP export needs Python 3.11–3.14 with `cadquery-ocp-novtk==7.9.3.1.1`.

**macOS installation:** Drag Bureau to Applications, eject the DMG and launch the app from Applications. If macOS blocks it, dismiss the message, then choose **System Settings → Privacy & Security → Open Anyway → Open** and authenticate if asked. The DMG includes these steps in `INSTALL.txt`. Bureau is a new app, so Omen Flow stays installed beside it until you move Omen Flow to the Bin; your settings are read from it either way. See [Apple's instructions](https://support.apple.com/en-us/102445).

Linux packages require glibc 2.35 or later; Debian/RPM packages also require the declared WebKitGTK runtime. The packages are now named `agentic-bureau` and install `/usr/bin/agentic-bureau`; they do not replace `omen-flow`, so remove it first (`sudo apt remove omen-flow` or `sudo dnf remove omen-flow`), as well as any withdrawn 1.0.x package.

Project storage stays schema 1 and existing APIs remain compatible. A 0.2.3 build can open a project 0.2.4 worked on, but it ignores 0.2.4's CAD checks; check parts again if you go back. See [the verification record](https://github.com/abdraiymbek/omen-flow/blob/main/audit/v0.2.4/README.md) for checks and limits.

VERIFICATION_PARAGRAPH_PENDING
