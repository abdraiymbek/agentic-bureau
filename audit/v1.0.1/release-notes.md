# Omen Flow 1.0.1 release notes

Published 2026-10-20T01:13:29Z as tag `v1.0.1` at `d091f0a040496e016c7ec2998f9c3e2606909980`; withdrawn on 21 October 2026 when the version line was renumbered 0.2.x. The text below is the release body as it was published.

Omen Flow 1.0.1 improves responsiveness and reliability across everyday engineering work.

- Faster revision-head reads for large projects, live refresh of objects, offers, files and decision evidence.
- Content search in the omnibar opens the matching revision and keeps it through Back/Forward navigation.
- Native close and quit protect unsaved edits; test observations stay tied to the procedure reviewed.
- More reliable terminal restoration, process cleanup and access to older recorded activity.
- Bounded CAD mesh caching and acceptance tied to geometry actually drawn in the viewport.
- Paged revision history for tools and faithful BOM, assembly and wiring exports.

Downloads include macOS Apple Silicon DMG and Linux arm64/x86_64 Debian, RPM and AppImage packages. Verify downloads with SHA256SUMS.

The macOS app is ad hoc signed and is not notarized. Requires macOS 13.3 or later. OpenSCAD and agent CLIs are installed separately.

**macOS installation:** Drag Omen Flow to Applications, eject the DMG and launch the app from Applications. If macOS blocks it, dismiss the message, then choose **System Settings → Privacy & Security → Open Anyway → Open** and authenticate if asked. The refreshed DMG includes these steps in `INSTALL.txt`. See [Apple's instructions](https://support.apple.com/en-us/102445).

The macOS download was repackaged with a verification gate: source and mounted app/helper signatures pass, every app file is preserved, and the packaged helper smoke passes. No signature corruption was found in the original app. This remains an ad hoc distribution without Apple notarization; warning text can vary by macOS. [Packaging verification](https://github.com/abdraiymbek/omen-flow/blob/main/audit/v1.0.1/macos-packaging-refresh.md).

Linux packages require glibc 2.35 or later; Debian/RPM packages also require the declared WebKitGTK runtime.

Project storage stays schema 1 and existing APIs remain compatible. See [the verification record](https://github.com/abdraiymbek/omen-flow/blob/main/audit/v1.0.1/README.md) for checks and limits.

Verification: 1,000 JavaScript tests passed with real OpenSCAD and no skips; Rust workspace, helper and conformance checks passed. Both Linux architectures passed fresh Ubuntu 22.04/24.04, Debian 12, AppImage and Fedora 42 smoke checks. The macOS app passed native unsaved-work checks, mounted-DMG and fresh-copy smoke tests. All seven package downloads were re-downloaded and verified against SHA256SUMS.

[CI](https://github.com/abdraiymbek/omen-flow/actions/runs/39350682966) · [Linux release build](https://github.com/abdraiymbek/omen-flow/actions/runs/39350699564)
