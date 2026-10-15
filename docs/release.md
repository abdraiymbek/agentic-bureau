# Release

There is no qualified release of the Rust/Tauri app. The latest native acceptance on macOS
Apple Silicon is the [26 September first-use audit](../audit/v1-readiness/README.md), made
before V1. V1 itself was verified by automated suites and the browser preview on the Rust
headless host ([V1 readiness record](../audit/v1/README.md)). Its release bundle and DMG were
built on macOS arm64; the app opened its main window, and the packaged smoke passed from the
mounted DMG. That bundle predates the move to version 1.0.0 and the identifier
`app.omenflow.desktop` (its `Info.plist` still says 0.1.0 and `com.electron.omen-flow`), so it must
be rebuilt. Nobody has yet used the native interface by hand. Apple signing, notarization,
clean-machine installation and upgrade, Intel Macs, and Windows packages are still open. Linux
packages (`.deb`, `.rpm`, AppImage) are built on Ubuntu 22.04, need glibc 2.35 or later, and were
run on arm64 in fresh containers under a virtual display ([Linux packages](#linux-packages)); no
Linux desktop has been used by hand. The Electron v0.1 record in `audit/release-v0.1/` is
historical and does not qualify this build.

## Local candidate

```sh
pnpm install --frozen-lockfile
pnpm rebuild:node
pnpm contracts:check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm build:bridge
cargo test -p omenflow-agent-host --locked -- --ignored
pnpm typecheck
pnpm lint
pnpm format:check
OMENFLOW_OPENSCAD_E2E=1 pnpm test
pnpm test:conformance
pnpm smoke:headless
pnpm make
pnpm smoke:packaged
```

`cargo test --workspace` needs OpenSCAD for its engine tests. `OMENFLOW_OPENSCAD_E2E=1` also runs
the legacy TypeScript real-engine tests.

`pnpm make` builds the Rust bridge helper, the static React renderer, and the Rust Tauri app
without signing. On macOS it creates `target/release/bundle/macos/Omen Flow.app` and an
unsigned DMG under `target/release/bundle/dmg/`. The DMG step lays out its window through
Finder with AppleScript, which needs the Finder automation permission of an interactive
session; where that is unavailable (background shells, CI), `CI=true pnpm make` skips the
layout and still produces the DMG with the app and an Applications link. The bundle declares
macOS 13.3 as its minimum, because the renderer targets the WebKit of Safari 16.4; it is
built for Apple Silicon only. The package contains no Electron or Node
runtime; the `omenflow` helper is bundled as a resource. OpenSCAD is a separately installed
engine.

`pnpm smoke:packaged` launches the bundle with disposable app data, has it create a project and
hand over an agent grant, then checks that the helper prints its usage, that the bridge refuses
an unknown token, and that the grant reads the project, writes a draft attributed to the agent,
reads it back and is refused a human-only operation. It is not a substitute for the native
flows: before calling a package releasable, run a real agent CLI session in the Agent tab, a
CAD render, a review approval, export and reopen of an archive, close and quit with an agent
running, and an upgrade of a populated earlier project.

## Publishing without notarization

Without an Apple Developer account the app is distributed ad hoc signed: `pnpm make` signs the
bundle with the ad hoc identity (`bundle.macOS.signingIdentity` is `-`), which seals every file in
it. That matters: an unsigned bundle downloaded from the web is reported as **damaged** with no way
to open it, while an ad hoc signed one is reported as unverified and can be opened once with
**Open Anyway** in System Settings → Privacy & Security (recent macOS versions no longer offer
the Control-click → Open shortcut). The install steps for users are in the README.

macOS also kills a quarantined command-line tool that an agent starts, even after the app was
allowed, and the `omenflow` helper is one. When the bundled helper carries the quarantine flag of
a download, the app writes a byte-for-byte copy to `bin/omenflow` in its data folder and gives
agents that copy (`apps/rust-desktop/src/helper.rs`); signed and notarized bundles use the
bundled helper directly.

Checked on macOS 27 with the 1.0.0 DMG: after a simulated browser download (quarantine set on the
DMG), `codesign --verify --deep --strict` is valid and Gatekeeper rejects the app as unverified
rather than damaged; the quarantined bundled helper is killed when run (exit 137); with the app
allowed and its helper still quarantined, the packaged smoke passed through the copy. The real
Open Anyway prompt was not clicked through here: download the published DMG on another Mac and
try it before announcing.

## Apple signing handoff

Install a Developer ID Application certificate in the keychain and store notarization
credentials with `xcrun notarytool store-credentials`. Set:

```sh
export OMENFLOW_SIGNING_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)'
export OMENFLOW_NOTARIZE_PROFILE='omenflow-notary'
pnpm release:macos
```

The release script builds the helper, the renderer and the app, signs the bundled `omenflow`
helper and then the app with the hardened runtime (inside out: `--deep` does not sign
executables shipped as resources, and notarization rejects any unsigned Mach-O), notarizes and
staples it, verifies its signature and Gatekeeper assessment, runs the
packaged smoke, then creates a DMG holding the stapled app and an Applications link, and signs,
notarizes, staples and assesses it. The DMG name follows the version in `tauri.conf.json`. Without either
variable (or off macOS) it stops before building: "Run on macOS with OMENFLOW_SIGNING_IDENTITY
and OMENFLOW_NOTARIZE_PROFILE." This path has not been run with real Apple credentials. Do not
publish solely because a DMG exists.

From 1.0 the bundle identifier is `app.omenflow.desktop` (earlier builds used
`com.electron.omen-flow`). On its first start, 1.0 copies `settings.json`, `reservations.json`
and `window-state.json` from the earlier identifier's data folder, and settings from the
Electron app's `@omenflow/desktop`, without overwriting anything it has already written and
leaving the old files in place; recent projects, agent and engine settings carry over that way.
Interface preferences kept in the webview's own storage (for example rail and window layout in
the renderer) start fresh, because that storage is keyed by the identifier. Projects live outside the app bundle
and must be backed up before upgrade acceptance. The last acceptance run must install the DMG on
a clean supported Mac, exercise the terminal and MCP, OpenSCAD, review, export and reopen, then
upgrade a copy of a populated earlier project and check its project ID, SQLite integrity,
selected revisions, object hashes and attachments.

[Official Tauri macOS signing and notarization guidance](https://v2.tauri.app/distribute/sign/macos/).

## Linux packages

```sh
node scripts/linux-package.mjs               # image, tests, packages, floors, then each package run fresh
node scripts/linux-package.mjs --skip-tests  # what CI runs (the suites have their own jobs)
node scripts/linux-package.mjs --skip-build  # run the packages already in the output folder again
```

Run the first command. It exits 0 only when every step passed, and it passes end to end (below).
`--keep-going` runs the remaining test and smoke steps after one fails and still exits 1; `--keep`
leaves the containers (`omenflow-linux-*`) for inspection, which are otherwise removed at the end,
also after a failure.

The script needs Docker, Node and a git checkout (it copies what `git ls-files` lists). On macOS,
run it against a Linux VM such as colima and select that daemon with `DOCKER_CONTEXT` (for
example `DOCKER_CONTEXT=colima-omenflow`) if it is not the current context; the packages are built
for the VM's architecture.

**Build base and compatibility floor.** The `omenflow-linux-build` image
(`scripts/linux/Dockerfile`) is Ubuntu 22.04 with the packages in `scripts/linux/build-deps.sh`
(Tauri 2's list, D-Bus, `xdg-utils`, which the AppImage step copies in, Xvfb and xdotool, and
Ubuntu's OpenSCAD 2021.01, which the Rust engine tests require), Node 24.19.0 checked against its
published SHA-256, pnpm 9.15.9 and Rust from the channel in `rust-toolchain.toml`. A binary can use
no glibc symbol newer than the glibc it was linked against and needs the newest one it uses at run
time, so building on 22.04 (glibc 2.35) makes that the floor: Ubuntu 22.04 and later, Debian 12 and
later, and Fedora releases with glibc 2.35 or later. The packages say so:

- `.deb`: `libc6 (>= 2.35)`, `libwebkit2gtk-4.1-0 (>= 2.41.90)`, `libdbus-1-3`, and Tauri's own
  `libwebkit2gtk-4.1-0, libgtk-3-0`. WebKitGTK needs the version because Ubuntu 22.04's release
  pocket has 2.36.0 (its updates have 2.50.4), and `dpkg-shlibdeps` dates the WebKitGTK symbols
  the app uses to 2.41.90.
- `.rpm`: `libc.so.6(GLIBC_2.35)(64bit)`, `libdbus-1.so.3()(64bit)`, and Tauri's
  `libwebkit2gtk-4.1.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`. glibc's own version capability is
  the rpm form of "glibc 2.35 or later": Tauri writes rpm requirements without version
  comparisons, so `glibc >= 2.35` would be read as a package of that name.

The numbers come from the binaries, not from the base: after packaging, the step "Declared glibc
and WebKitGTK floors" reads the newest `GLIBC_` symbol of the app, the helper and every file inside
the AppImage with `objdump -T`, runs `dpkg-shlibdeps` on the app and the helper, and fails if a
declaration is below what they need, the two packages disagree, or the floor is above the build
base's own glibc. On arm64: the app needs `GLIBC_2.35` (for example `hypot`, in libm), the helper
`GLIBC_2.34`, everything in the AppImage `GLIBC_2.35`; `dpkg-shlibdeps` derives the same
`libc6 (>= 2.35)` and `libwebkit2gtk-4.1-0 (>= 2.41.90)`. On Ubuntu 20.04 (glibc 2.31), `apt`
refuses the `.deb` ("Depends: libc6 (>= 2.35) but 2.31-0ubuntu9.17 is to be installed") instead
of installing an app that cannot start.

The app links only glibc, libgcc and the GTK, WebKitGTK and D-Bus stack. It has no screen-capture
library on Linux: the research screenshot is taken by WebKitGTK (`webkit_web_view_get_snapshot`,
`apps/rust-desktop/src/capture.rs`), which works under X11 and Wayland alike. (The crate used on
macOS and Windows, xcap, sees only X11 windows on Linux and links PipeWire, EGL, GBM and Wayland;
its PipeWire bindings do not build against Ubuntu 22.04's PipeWire 0.3.48.)

**What runs.** The script copies the files git tracks or would track (never a bind mount, never
`node_modules`, `target/` or `.git`) into a container of the image and, as an ordinary user, runs
`pnpm install --frozen-lockfile`, `pnpm rebuild:node`, `pnpm contracts:check`, `pnpm build:bridge`,
`cargo test --workspace`, the helper tests and the real-helper round trip, `pnpm test:conformance`,
`pnpm smoke:headless`, then `pnpm make --bundles deb,rpm,appimage` (`APPIMAGE_EXTRACT_AND_RUN=1`,
since containers have no FUSE) and the floors check. The packages are copied to
`target/release/bundle/linux-<arch>/` (`linux-arm64`, `linux-amd64`), which is emptied first. Then
each runs on systems that have never seen the build:

- the `.deb` is installed with `apt-get install --no-install-recommends ./…deb` on fresh
  `ubuntu:22.04`, `ubuntu:24.04` and `debian:12`, which must bring every library: `ldd` of the app
  and the helper may report nothing `not found`;
- the AppImage runs on a fresh `ubuntu:22.04` with no WebKitGTK and no GTK, only the display tools
  and the libraries an AppImage leaves to the host (EGL, OpenGL ES and GL, HarfBuzz, FriBidi;
  every desktop with GTK has them);
- the `.rpm` is installed with `dnf install` on a fresh `fedora:42`.

Each is launched by an ordinary user under `xvfb-run` with disposable app data and must pass
`node scripts/rust-packaged-smoke.mjs --linux <executable>` (run with the build image's Node,
because Ubuntu 22.04's own is version 12):

- the app creates a project and hands over an agent grant; the helper it resolved must be the
  packaged one (`<prefix>/lib/Omen Flow/omenflow`); the helper prints its usage, the bridge
  refuses an unknown token, and the grant reads the project, writes an agent draft, reads it back
  and is refused `proposal.approve`;
- the login shell the app asks for its PATH must not inherit an AppImage's environment;
- one visible top-level window titled Omen Flow of at least 1024 × 700 must exist, and the app
  must still be running five seconds later;
- the screen is captured (xwd, converted to PNG by the script itself, because Ubuntu 22.04's
  `xwdtopnm` misreads Xvfb's 32-bit dumps), and at the same moment the app pictures its page the
  way the research screenshot does (WebKitGTK); the picture must be the window's size;
- a stand-in agent CLI is started in the smoke project's Agent tab as a Custom CLI (a real PTY):
  it must lead its own session and process group and reach the bridge through the `omenflow` on
  its PATH, which must be the packaged helper;
- the app is sent SIGTERM: it must quit with status 0, and the agent's process group must be gone.

The X screen and the page picture of each run (`smoke-<package>-<system>.png` and
`…-webview.png`) land next to the packages. On Debian or Ubuntu the same build runs without
containers after `sudo sh scripts/linux/build-deps.sh --openscad`, Node 24, pnpm 9.15.9 and rustup.

What the packages hold (Tauri reads `tauri.conf.json` `bundle.linux` and merges
`tauri.linux.conf.json` only when building on Linux, so the macOS bundle is unchanged):

|               | `.deb` / `.rpm`                                                                                                                                                                                                             | AppImage                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Name, version | `omen-flow` 1.0.0 (rpm release 1), section `devel`, license Apache-2.0, maintainer "Omen Flow contributors"                                                                                                                 | `Omen Flow_1.0.0_<arch>.AppImage`        |
| App           | `/usr/bin/omen-flow`                                                                                                                                                                                                        | `usr/bin/omen-flow` inside the image     |
| Helper        | `/usr/lib/Omen Flow/omenflow`, where `cli_path` finds it (Tauri's resource folder is `../lib/<productName>` beside the executable)                                                                                          | `$APPDIR/usr/lib/Omen Flow/omenflow`     |
| Menu entry    | `/usr/share/applications/Omen Flow.desktop`: `Name=Omen Flow`, `Exec=omen-flow`, `Icon=omen-flow`, `StartupWMClass=omen-flow` (the window's `WM_CLASS`), `Categories=Development;`; `desktop-file-validate` reports nothing | the same entry inside the image          |
| Icons         | hicolor 32, 128 and 512 px                                                                                                                                                                                                  | the same                                 |
| License       | `/usr/share/doc/omen-flow/{copyright,NOTICE}`, `/usr/share/licenses/omen-flow/{LICENSE,NOTICE}` (rpm)                                                                                                                       | `usr/share/doc/omen-flow/`               |
| Depends       | glibc 2.35, WebKitGTK 4.1 (2.41.90 or later in the `.deb`), GTK 3 and D-Bus, as above                                                                                                                                       | bundled, except the host libraries above |

The app keeps its data in `~/.local/share/app.omenflow.desktop` (the bridge socket is
`run/bridge.sock` inside it; Linux allows 108 bytes for a socket path). A second start hands over
to the running window through the D-Bus session bus.

**Quitting on signals.** SIGTERM (a session logging out, `kill`, a service manager), SIGINT
(Ctrl-C in the terminal that started it) and SIGHUP (that terminal closing) quit the desktop app
through its normal exit path (`apps/rust-desktop/src/signals.rs`, on Linux and macOS): it saves the
window's place, stops each agent session's whole process group and any OpenSCAD render, and exits
with status 0. A second signal while that runs ends the process at once. Mounted through FUSE, the
AppImage's launched process is the app itself, so a SIGTERM to it or to its whole process group
quits cleanly and the image is unmounted. Unpacked with `APPIMAGE_EXTRACT_AND_RUN=1`, the
AppImage runtime (type2-runtime 8f39b89) forks the app and waits for it: a SIGTERM to the app quits
it cleanly, but one sent to the runtime alone ends only the runtime (status 143) and leaves the app
running, and the runtime never removes its `/tmp/appimage_extracted_…` folder, not even after a
clean exit (traced: after `wait4` it calls `exit_group(0)` without removing anything).

**Verified on arm64, 14 October 2026** ([record](../audit/v1/README.md#linux-packages--14-october-2026)):
`DOCKER_CONTEXT=colima-omenflow node scripts/linux-package.mjs` passed every step from 22:56 to
23:19 UTC (1364 s, exit 0): the Rust workspace (562 tests passed, 1 ignored, no engine test
skipped, with OpenSCAD 2021.01), the helper tests and real-helper round trip, the conformance suite
(52 tests), the headless smoke, the packages (`.deb` 11,253,306 bytes, `.rpm` 11,252,543, AppImage
86,714,888), the floors, and the smoke on every system. apt installed 201 packages on Ubuntu 22.04,
216 on 24.04 and 223 on Debian 12, dnf 261 on Fedora 42, and `ldd` found nothing missing. Each run
showed a 1440 × 900 window and a 1440 × 900 page picture; its stand-in agent led its own session and
group and reached the bridge through the packaged helper; SIGTERM ended the app with status 0 and
the agent's group with it. Separately, in containers: the same AppImage mounted through FUSE on
Ubuntu 22.04 quit with status 0 and unmounted after a SIGTERM to it or to its whole process group,
and apt refused the same `.deb` on Ubuntu 20.04. Earlier the same day, on the first (Ubuntu
24.04-based) `.deb`, xdotool and wmctrl (not a person) drove the window under openbox, a close
request (exit 0, window state saved), a second start, and the Agent tab with a stand-in `claude`
that "Stop agent and close" ended with its process group.

**x86_64**: the `package-linux` job in `.github/workflows/ci.yml` runs
`node scripts/linux-package.mjs --skip-tests` on `ubuntu-22.04` and uploads the `.deb`, `.rpm` and
AppImage (`omenflow-linux-x86_64`) and the screenshots. It is the same script that ran on arm64, but
it has not run: no x86_64 package has been built or launched. The Linux leg of the `rust` job is
set to run on `ubuntu-22.04` too, installing and requiring Ubuntu's OpenSCAD; it has not run
either.

Known limits:

- **Unsigned.** No GPG signature on the `.deb` or `.rpm`, no signed AppImage, no update
  information, no apt or dnf repository. Nothing was installed over an earlier Linux build
  (there is none).
- **Not a desktop.** Every run used Xvfb (X11, no window manager unless stated, Mesa llvmpipe, no
  GPU). Wayland sessions, GPU drivers, HiDPI scaling, input methods and the system tray were not
  exercised. The AppImage's GTK launcher forces `GDK_BACKEND=x11`, so on Wayland it runs through
  XWayland; the `.deb` and `.rpm` use GTK's default backend. The research window, and so the
  research screenshot, was not exercised on Linux; the same WebKitGTK snapshot of the main window
  was.
- **Native dialogs.** Under Xvfb the GTK dialogs (folder picker, save, "An agent is still
  working") never appear in a screenshot of the screen: black without a compositor, see-through
  with `xcompmgr`. They work (their own window image shows the right content, and clicking
  Cancel or "Stop agent and close" there acted), and a minimal Tauri 2.11 window with an rfd or a
  plain GTK dialog behaves the same, while a GTK program without Tauri shows its dialogs. Look at
  them on a real desktop before release.
- **AppImage.** Its runtime (AppImage type2-runtime) mounts the image through `/dev/fuse` and
  needs a `fusermount3` or `fusermount` executable: on Ubuntu and Debian the `fuse3` package
  (`fuse` for `fusermount`). The `libfuse2` or `libfuse2t64` library alone is not enough ("No
  suitable fusermount binary found on the $PATH"). Without FUSE, `APPIMAGE_EXTRACT_AND_RUN=1`
  unpacks it under `/tmp` instead, which the runtime then leaves behind (about 270 MB; see
  signals above). It also needs the host's EGL, OpenGL ES/GL, HarfBuzz and FriBidi. Its launcher
  sets `LD_LIBRARY_PATH`, `PYTHONHOME`, `PATH`, GTK, GIO, GStreamer and Qt paths for the app;
  agent terminals, the login-shell and version probes, OpenSCAD and links opened in the browser
  get the session's environment back and start outside the image (`omenflow_core::child_env`).
- **OpenSCAD.** Ubuntu 22.04 and 24.04 and Debian 12 ship OpenSCAD 2021.01, and every Rust engine
  test passes with it. Its CGAL kernel is slow on large 3D booleans: a sphere with
  `$fn = 560` minus a cylinder took 134 s with 22.04's build and 142 s with 24.04's (1 min 54 s of
  it CGAL), against the default render timeout of 90 s; current snapshots with the Manifold
  backend take seconds. The app finds OpenSCAD in `/usr/bin`, `/usr/local/bin`, `/snap/bin` or on
  the PATH; a Flatpak or AppImage OpenSCAD must be set in Settings.
- **Agent CLIs.** Found through the login shell's PATH, the inherited PATH, the per-user folders
  listed in [agent adapters](agent-adapters.md) and, on Linux, Homebrew on Linux and `/snap/bin`.
  Only stand-in executables were run on Linux, not Codex CLI or Claude Code.
- **Distributions.** Verified, all arm64: the `.deb` on Ubuntu 22.04, Ubuntu 24.04 and Debian 12,
  the AppImage on Ubuntu 22.04 (unpacked by the script, and mounted through FUSE in a container
  with `fuse3` installed, started with `--device /dev/fuse --cap-add SYS_ADMIN` and, where Docker
  applies its AppArmor profile as in colima's VM, `--security-opt apparmor=unconfined`; without
  that the runtime stops with "fuse: mount failed: Permission denied"), the `.rpm` on Fedora 42.
  Other distributions with glibc 2.35 or later and WebKitGTK 4.1 were not run. Older systems
  (Ubuntu 20.04, Debian 11, the RHEL 9 family with glibc 2.34) are below the floor: apt refused the
  `.deb` on Ubuntu 20.04, dnf was not tried on one, and the AppImage's contents need `GLIBC_2.35`
  as well.
- On every platform the bridge socket file stays after quit (the host is never dropped); the next
  start replaces it.
