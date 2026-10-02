# Rust desktop release

The Rust/Tauri migration is qualified locally on macOS Apple Silicon as an
unsigned candidate. Apple signing, notarization, clean-machine upgrade, and
Windows/Linux runtime acceptance are still open. The Electron v0.1 release
record in `audit/release-v0.1/` is historical and does not qualify this build.
The [26 September first-use audit](../audit/v1-readiness/README.md) records the
current Lens candidate, native acceptance, and remaining distribution gates.

## Local candidate

```sh
pnpm install --frozen-lockfile
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm typecheck
pnpm lint
pnpm format:check
OMENFLOW_OPENSCAD_E2E=1 pnpm test
pnpm make
pnpm smoke:packaged
```

`pnpm make` builds the Rust bridge helper, the static React renderer, and the
Rust Tauri app. On macOS it creates
`target/release/bundle/macos/Omen Flow.app` and an unsigned DMG under
`target/release/bundle/dmg/`. The package contains no Electron or Node runtime.
OpenSCAD is a separately installed engine. Run a native CAD render, terminal
session, review approval, export/reopen, and populated-project upgrade test
before calling a package releasable. The smoke script currently checks app
launch, bridge framing, helper presence, and unauthenticated denial; it is not
a substitute for those native flows.

## Apple signing handoff

Install a Developer ID Application certificate in the keychain and store
notarization credentials with `xcrun notarytool store-credentials`. Set:

```sh
export OMENFLOW_SIGNING_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)'
export OMENFLOW_NOTARIZE_PROFILE='omenflow-notary'
pnpm release:macos
```

The release script builds the Rust app, signs it with hardened runtime,
notarizes and staples the app, verifies its signature and Gatekeeper assessment,
runs packaged smoke, then creates, signs, notarizes, staples, and assesses the
DMG. It fails closed when either credential is missing. This path has not been
run with real Apple credentials. Do not publish solely because a DMG exists.

The bundle identifier remains `com.electron.omen-flow` to preserve the previous
installation identity. Changing it requires an explicit upgrade plan. Projects
live outside the app bundle and must be backed up before upgrade acceptance.
The last acceptance run must install the DMG on a clean supported Mac, exercise
terminal/MCP, OpenSCAD, review, export and reopen, then upgrade a copy of a
populated Electron project and check its project ID, SQLite integrity, selected
revisions, object hashes and attachments.

[Official Tauri macOS signing and notarization guidance](https://v2.tauri.app/distribute/sign/macos/).
