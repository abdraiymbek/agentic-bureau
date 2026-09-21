# Release

The v0.1 qualification target is **macOS Apple Silicon**. Intel macOS, Windows and
Linux builds remain unqualified until their own native acceptance runs pass.
See `audit/release-v0.1/README.md` for current evidence and remaining gates.
Historical model scores in the build ledger are not current release approval.

## Local candidate

```sh
pnpm install --frozen-lockfile
pnpm rebuild:node
pnpm typecheck
pnpm lint
pnpm format:check
OMENFLOW_OPENSCAD_E2E=1 pnpm test
pnpm make
pnpm smoke:packaged --cad
```

OpenSCAD must be installed for the real CAD and packaged CAD checks. Record its
version, OS version, CLI version/model configuration, source revision and dirty
diff with the results. The Rust bridge also requires `cargo fmt --check`,
`cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked`
from `native/omenflow-bridge`.

Generated Apple Silicon files:

- `apps/desktop/out/Omen Flow-darwin-arm64/Omen Flow.app`
- `apps/desktop/out/make/Omen Flow.dmg`
- `apps/desktop/out/make/zip/darwin/arm64/Omen Flow-darwin-arm64-0.1.0.zip`

Without signing configuration, `pnpm make` produces a local unsigned candidate.
It must not be represented as a notarized public release. Projects are stored
outside the application bundle and are not deleted on uninstall.

## Apple account handoff

The application does not need a UI or storage redesign to enable signing. Install
a **Developer ID Application** certificate with its private key into the build
machine's login keychain, then use the interactive command to store notarization
credentials (Apple ID plus app-specific password and team, or an Apple API key):

```sh
xcrun notarytool store-credentials omenflow-notary
```

Set the exact identity returned by `security find-identity -v -p codesigning`:

```sh
export OMENFLOW_SIGNING_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)'
export OMENFLOW_NOTARIZE_PROFILE='omenflow-notary'
pnpm release:macos
```

The release command requires both inputs. Forge signs with hardened runtime and
the checked-in JIT entitlement, notarizes and staples the app, then the script
verifies the signature, ticket and Gatekeeper assessment, runs the packaged
calculation/CAD smoke, and signs, notarizes, staples and assesses the DMG. Every
failed step stops the command. Credentials stay in the keychain; no password or
private key belongs in source control. `OMENFLOW_RELEASE_SIGNED=1 pnpm make`
also refuses to build if either signing input is absent.

Signing configuration tests pass without credentials. Actual Apple acceptance
and clean-machine Gatekeeper installation remain untested until the account is
available. Before publication, install the resulting DMG on a clean supported
Mac, exercise terminal, render, review, export and reopen, then test upgrade over
the previous candidate using a copy of a populated project. Verify project
identity, selected revisions and attachments survive. Do not publish merely
because a DMG exists.

The bundle identifier is preserved as `com.electron.omen-flow` for this release;
changing it later requires a deliberate identity/upgrade decision.

References: [Electron Forge signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
and [Electron notarization](https://github.com/electron/notarize).
