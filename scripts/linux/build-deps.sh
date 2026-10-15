#!/bin/sh
# System packages that build and test Omen Flow on Debian/Ubuntu. Ubuntu 22.04 is the
# build base (scripts/linux/Dockerfile) and the oldest verified; the same names install
# on Ubuntu 24.04. Used by the Dockerfile and by the Linux CI jobs, so the container
# build and CI install the same list. Run as root (or through sudo).
#
#   scripts/linux/build-deps.sh            build and package (Tauri, node-pty)
#   scripts/linux/build-deps.sh --display  also the virtual display tools the packaged
#                                          smoke uses (xvfb, xauth, xdotool, x11-utils, x11-apps)
#   scripts/linux/build-deps.sh --openscad also the distribution's OpenSCAD, which the Rust
#                                          engine tests require (2021.01 on Ubuntu 22.04)
set -eu

packages="
  build-essential pkg-config curl wget file ca-certificates xz-utils git python3 xdg-utils
  libwebkit2gtk-4.1-dev libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev
  libdbus-1-dev
"
# Tauri 2's Linux prerequisites: libwebkit2gtk-4.1-dev, build-essential, curl, wget,
# file, libxdo-dev, libssl-dev, libayatana-appindicator3-dev, librsvg2-dev
# (https://v2.tauri.app/start/prerequisites/#linux), and D-Bus for the window library
# (tao). git and python3 build node-pty from source (node-gyp). The AppImage bundler
# copies /usr/bin/xdg-open (xdg-utils) into the image for the opener plugin and fails
# without it. No screen-capture libraries: on Linux the research screenshot comes from
# WebKitGTK itself (apps/rust-desktop/src/capture.rs).

for option in "$@"; do
  case "$option" in
    --display) packages="$packages xvfb xauth xdotool x11-utils x11-apps" ;;
    --openscad) packages="$packages openscad" ;;
    *) echo "build-deps.sh: unknown option $option" >&2; exit 2 ;;
  esac
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
# shellcheck disable=SC2086
apt-get install --no-install-recommends -y $packages
