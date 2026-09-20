# Release

## Artifacts

| Target      | File                                    | Notes                       |
| ----------- | --------------------------------------- | --------------------------- |
| macOS arm64 | `Omen Flow-<version>-mac-arm64.dmg`     | Apple Silicon               |
| macOS x64   | `Omen Flow-<version>-mac-x64.dmg`       | Intel                       |
| Windows x64 | `Omen Flow-<version>-win-x64-Setup.exe` | Per-user Squirrel installer |

Baselines: macOS 14+, Windows 11 x64. Linux `.deb`/`.rpm` kept portable, not
advertised until verified.

## Mechanics

- Electron Forge makers; native runners per platform in CI.
- Rebuild better-sqlite3 + node-pty for the exact Electron ABI/arch.
- Unsigned contributor builds are clearly marked; signing/notarization are
  maintainer inputs via CI secrets — never committed.
- `Check for updates` is user-initiated and opens the configured release page.
- Projects are never deleted on uninstall.

## Verification matrix

Record tested versions: Electron, agent CLIs, OpenSCAD, OS builds.
See `BUILD_STATUS.md` for the current verification state.
