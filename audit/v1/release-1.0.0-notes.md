# Omen Flow 1.0.0 release notes

Published 2026-10-15T02:46:43Z as tag `v1.0.0` at `54b89b6e74d9dee2658e7a30dee4a879ae29095e`; withdrawn on 21 October 2026 when the version line was renumbered 0.2.x. The text below is the release body as it was published.

Omen Flow is a local desktop engineering workspace. You bring an agent CLI — Claude Code, Codex CLI or another — it runs in a real terminal inside the app and drafts engineering work: requirements, parts, CAD, calculations, wiring and tests. Nothing it writes becomes the baseline until you approve it. Your projects stay in folders on your machine.

## Download

| Platform                           | File                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| macOS 13.3+ (Apple Silicon)        | `Omen-Flow-1.0.0-macos-arm64.dmg`                                                                |
| Ubuntu 22.04+, Debian 12+ (x86_64) | `omen-flow_1.0.0_amd64.deb`                                                                      |
| Fedora 42+ (x86_64)                | `omen-flow-1.0.0-1.x86_64.rpm`                                                                   |
| Other Linux (x86_64)               | `Omen-Flow-1.0.0-x86_64.AppImage`                                                                |
| Linux on ARM (arm64)               | `omen-flow_1.0.0_arm64.deb`, `omen-flow-1.0.0-1.aarch64.rpm`, `Omen-Flow-1.0.0-aarch64.AppImage` |

`SHA256SUMS` lists the checksum of every file. Installation steps, requirements and how to uninstall are in the [README](https://github.com/abdraiymbek/omen-flow#install).

**macOS:** the app is not notarized by Apple. After dragging it to Applications, open it once, choose **Done**, then go to **System Settings → Privacy & Security** and choose **Open Anyway**.

**Linux is a preview.** The packages were installed and run in fresh Ubuntu 22.04, Ubuntu 24.04, Debian 12 and Fedora 42 systems, but not yet on a real desktop. Please [open an issue](https://github.com/abdraiymbek/omen-flow/issues) with what you find.

You also need an agent CLI, installed and signed in (Claude Code and Codex CLI are verified with this release), and [OpenSCAD](https://openscad.org) for rendering and checking parts.

## What's in 1.0

- **An agent layer that adapts to the model.** Each session gets a capability profile from its model: small models (Haiku, mini, local models) see 13 flat tools, short playbooks on demand, input mistakes repaired and reported, and a completion check (`work_status`) to call before claiming they are done; large models keep all 57 tools. Verification rules are identical in every profile. In live runs on the release path, the compact profile cut Haiku's input tokens by 22–76% with the same results, and every evaluated task passed after the fixes those runs uncovered.
- **See what the agent did.** The Agent tab has a session bar (agent, model, profile, calls, failures) and an activity rail fed only by recorded tool calls, with the objects each call touched.
- **The Evidence lens** (`⌘5`): every requirement next to its calculations and tests, with coverage stated in words. Pass and fail come only from recorded test results, never from comparing numbers.
- **Decisions you can trust.** A typed field-level diff (quantities change atomically, bounds included), full content for new objects, CAD verification evidence, an approval guard that ignores keystrokes behind dialogs, and refusal when the baseline moved since the proposal was drafted.
- **A rebuilt flow map** that is readable at its default fit, routes links between columns with arrows, and is fully keyboard navigable.
- **Edits are never silently lost.** Background changes, an agent drafting the same object, or navigation no longer discard what you are typing.
- **CAD**: renders no longer freeze the interface, simpler check inputs with the same verification strength, a viewport with standard views, a section plane, measuring and bounds.
- **Engineering integrity throughout**: units are converted in BOM totals, calculations and wiring; unknown values stay unknown; approval is never presented as validation.

## Verified

Rust 565 tests, TypeScript 967 tests, a 52-case conformance suite against the real Rust host, an adversarial review whose 35 confirmed defects were each fixed with a regression test, a live small/large-model evaluation of the agent layer, and packaged smoke tests of every file in this release. The full record is in [`audit/v1/README.md`](https://github.com/abdraiymbek/omen-flow/blob/main/audit/v1/README.md).

## Known limitations

- macOS: Apple Silicon only, not notarized. Intel Macs and Windows are not supported in this release.
- Linux: a preview; not yet used on a real desktop (Wayland, GPU, HiDPI, native dialogs on screen are unverified). The AppImage needs FUSE 3.
- Research browsing (reading supplier pages in an isolated webview) is desktop-only.
- The agent runs with your operating-system permissions; the review gate controls what enters the engineering baseline, it is not a sandbox. See [`SECURITY.md`](https://github.com/abdraiymbek/omen-flow/blob/main/SECURITY.md).

Licensed under Apache-2.0. Third-party components are listed in [`THIRD_PARTY_NOTICES.md`](https://github.com/abdraiymbek/omen-flow/blob/main/THIRD_PARTY_NOTICES.md).
