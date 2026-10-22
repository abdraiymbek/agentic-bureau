# Omen Flow 1.0.2 release notes

Published 2026-10-21T02:07:07Z as tag `v1.0.2` at `c6c4d8ef735c7b411b8e8a8870ee67276db6e787`; withdrawn on 21 October 2026 when the version line was renumbered 0.2.x. The text below is the release body as it was published.

Omen Flow 1.0.2 adds a conversation to the Agent tab, beside the terminal.

- **Conversation pane.** Write what you want and press Send: Codex CLI or Claude Code runs once per message, its text appears as it arrives, and it can show a part in 3D with its dimensions, recorded objects, quantities, illustrative charts, choices and human review right in the thread. The terminal pane still runs any agent CLI interactively; switch with Conversation | Terminal.
- **Prepare → Send.** Edit a card's dimensions and Prepare attaches the exact values, units and revision to your request. Only Send runs the agent, and approval stays your decision in the review card or Decisions.
- **One agent per project.** A conversation and a terminal session never run in the same project at once; each pane offers to stop the other.
- **Ask follows the pane.** Every “Ask agent” action drafts into the conversation or pastes into the terminal, whichever is active. Nothing is sent for you.
- The floating window (⌘J) and the dock show the conversation compactly beside your lenses; cards link to the full Object view and Decisions.

Downloads include a macOS Apple Silicon DMG and Linux arm64/x86_64 Debian, RPM and AppImage packages. Verify downloads with SHA256SUMS.

The macOS app is ad hoc signed and is not notarized. Requires macOS 13.3 or later. OpenSCAD and agent CLIs are installed separately.

**macOS installation:** Drag Omen Flow to Applications, eject the DMG and launch the app from Applications. If macOS blocks it, dismiss the message, then choose **System Settings → Privacy & Security → Open Anyway → Open** and authenticate if asked. The DMG includes these steps in `INSTALL.txt`. See [Apple's instructions](https://support.apple.com/en-us/102445).

Linux packages require glibc 2.35 or later; Debian/RPM packages also require the declared WebKitGTK runtime.

Project storage stays schema 1 and existing APIs remain compatible. Conversations are kept in the project folder (`.omenflow/chat/`) and are not included in project archives. See [the verification record](https://github.com/abdraiymbek/omen-flow/blob/main/audit/v1.0.2/README.md) for checks and limits.

Verification: 1,046 JavaScript tests passed with real OpenSCAD and no skips; Rust workspace (599), helper and conformance (63) checks passed. Both Linux architectures passed fresh Ubuntu 22.04/24.04, Debian 12, AppImage and Fedora 42 smoke checks. The macOS DMG passed mounted-package signature checks and the packaged smoke. The conversation pane was reviewed in the design preview, including one real Claude Code run; it has not been walked through by hand in the native app. All seven package downloads were re-downloaded and verified against SHA256SUMS.

[CI](https://github.com/abdraiymbek/omen-flow/actions/runs/39528399368) · [Linux release build](https://github.com/abdraiymbek/omen-flow/actions/runs/39529932596)
