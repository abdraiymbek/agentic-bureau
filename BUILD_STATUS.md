# Build status

This file used to be the running ledger of the Electron build. That ledger described packages,
packaging and test counts that no longer exist in this tree, so it has been replaced by this
pointer. Its last text is in git history (`git show 4f8afe2:BUILD_STATUS.md`).

## Current

**0.2.3, 21 October 2026: a published preview, ad hoc signed and not notarized.** Releases
0.2.0–0.2.3 were first published as 1.0.0–1.0.3 and renumbered the same day; see
[release](docs/release.md).

- What Omen Flow is, how to build it and its limits: [README](README.md).
- What was verified for 0.2.3: [its verification record](audit/v0.2.3/README.md); for the
  14 October V1 work, with the commands and counts: [V1 readiness record](audit/v1/README.md),
  and for the interface [design verification](design-system/verification.md).
- How to qualify a release, and what is still open: [release](docs/release.md).

## Open gates

- The native macOS app was not walked through during V1 work. The last native walkthrough is
  the [26 September audit](audit/v1-readiness/README.md), which predates V1.
- Apple signing and notarization have never run with real credentials; clean-machine install
  and upgrade of a populated project are untested.
- Windows: CI defines an experimental package job; not a verified platform.
- Linux: the `.deb`, `.rpm` and AppImage are built by `node scripts/linux-package.mjs`
  on Ubuntu 22.04, and both packages declare its glibc 2.35 as their floor. For arm64 they
  were built and smoke-tested in containers under a virtual X display: the `.deb` on Ubuntu
  22.04, Ubuntu 24.04 and Debian 12, the AppImage on Ubuntu 22.04, the `.rpm` on Fedora 42.
  x86_64 packages come from the same recipe in the release workflow. No real Linux desktop
  (Wayland, a GPU, HiDPI, a person) has been used, and nothing is signed. See
  [release](docs/release.md#linux-packages).
- VoiceOver and the operating system's reduced-motion setting have not been checked.

## Earlier records

| Record                                                          | Covers                                            |
| --------------------------------------------------------------- | ------------------------------------------------- |
| [`audit/v1-readiness/`](audit/v1-readiness/README.md)           | First-use hardening of the Rust app, 26 September |
| [`audit/rust-migration/`](audit/rust-migration/after/README.md) | Electron baseline and Rust after measurements     |
| [`audit/release-v0.1/`](audit/release-v0.1/README.md)           | The Electron v0.1 candidate; does not transfer    |
| [`evals/cad/results/`](evals/cad/results/)                      | CAD evaluations on the legacy TypeScript stack    |
