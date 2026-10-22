# Omen Flow 1.0.3 release notes

Published 2026-10-21T03:33:53Z as tag `v1.0.3` at `918d58d67786c2d96e565485b8cf5bf4021caa3d`; withdrawn on 21 October 2026 when the version line was renumbered 0.2.x. The text below is the release body as it was published.

Omen Flow 1.0.3 adds an introduction that plays once on first launch.

- **Four acts on a real map.** The sample rover's causal map draws itself from intent to evidence and lights a thread; the camera tray zooms into a live 3D stage between what it depends on and what it affects; then you approve a proposal yourself and watch its impact travel the recorded links and mark four dependents out of date. Approval never means validated.
- **Setup that does the real thing.** The steps detect the agent CLIs on your machine and remember your choice, probe OpenSCAD and let you locate it, switch Graphite or Paper live, light each shortcut as you press it, and say where your projects and the app's settings live.
- **Skip or replay any time.** `Esc` skips; Settings → Appearance, the launcher's footer, `⌘K` (Introduction) and the design-system catalogue play it again. Nothing in the introduction reaches a project record.

Downloads include a macOS Apple Silicon DMG and Linux arm64/x86_64 Debian, RPM and AppImage packages. Verify downloads with SHA256SUMS.

The macOS app is ad hoc signed and is not notarized. Requires macOS 13.3 or later. OpenSCAD and agent CLIs are installed separately.

**macOS installation:** Drag Omen Flow to Applications, eject the DMG and launch the app from Applications. If macOS blocks it, dismiss the message, then choose **System Settings → Privacy & Security → Open Anyway → Open** and authenticate if asked. The DMG includes these steps in `INSTALL.txt`. See [Apple's instructions](https://support.apple.com/en-us/102445).

Linux packages require glibc 2.35 or later; Debian/RPM packages also require the declared WebKitGTK runtime.

Project storage stays schema 1 and existing APIs remain compatible; no host behaviour changed. See [the verification record](https://github.com/abdraiymbek/omen-flow/blob/main/audit/v1.0.3/README.md) for checks and limits.

Verification: 1,059 JavaScript tests passed with real OpenSCAD and no skips; Rust workspace (599), helper (13) and conformance (63) checks passed. Both Linux architectures passed fresh Ubuntu 22.04/24.04, Debian 12, AppImage and Fedora 42 smoke checks. The macOS DMG passed mounted-package signature checks and the packaged smoke. The introduction was reviewed in the design preview in Graphite and Paper at 1440×900 and 1024×700, with real agent CLI and OpenSCAD detection; it has not been walked through by hand in the native app. All seven package downloads were re-downloaded and verified against SHA256SUMS.

[CI](https://github.com/abdraiymbek/omen-flow/actions/runs/39537082012) · [Linux release build](https://github.com/abdraiymbek/omen-flow/actions/runs/39537926356)
