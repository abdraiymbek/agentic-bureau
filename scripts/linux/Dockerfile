# Build and test image for the Bureau Linux packages (deb, rpm, AppImage).
#
# Built and used by scripts/linux-package.mjs, which copies the working tree into a
# container of this image (never a bind mount: node_modules and target/ on the host
# hold that machine's binaries). The image holds only tools; no sources.
#
#   docker build -t bureau-linux-build scripts/linux
#
# It builds for the architecture Docker runs it on (arm64 on Apple Silicon through
# colima, x86_64 on GitHub's runners).
#
# Ubuntu 22.04 (glibc 2.35) is the compatibility floor. A binary can use no glibc symbol
# newer than the glibc it is linked against, and needs the newest one it uses at run time,
# so building on the oldest supported base lets the packages run there and on anything
# newer: Ubuntu 22.04 and later, Debian 12, current Fedora. The AppImage bundles this
# base's libraries, so the same holds for it. The packages declare the glibc version
# their binaries need; scripts/linux-package.mjs checks the declaration against them.
FROM ubuntu:22.04

# Tauri 2 and node-pty build requirements, the virtual display the packaged smoke
# launches the app on, and Ubuntu's OpenSCAD (2021.01), which the Rust engine tests
# require: without it they fail rather than skip.
COPY build-deps.sh /usr/local/sbin/bureau-build-deps
RUN chmod 755 /usr/local/sbin/bureau-build-deps \
  && bureau-build-deps --display --openscad \
  && rm -rf /var/lib/apt/lists/*

# Node (the version the macOS record used; .nvmrc says 24), checked against the
# release's published SHA-256 sums, and pnpm as pinned by package.json packageManager.
ARG NODE_VERSION=24.19.0
ARG PNPM_VERSION=9.15.9
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; \
    *) echo "unsupported architecture" >&2; exit 1 ;; \
  esac; \
  name="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
  cd /tmp; \
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${name}"; \
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
  grep " ${name}\$" SHASUMS256.txt | sha256sum -c -; \
  tar -xJf "$name" -C /usr/local --strip-components=1 --no-same-owner; \
  rm -f "$name" SHASUMS256.txt; \
  npm install -g "pnpm@${PNPM_VERSION}"; \
  node --version; pnpm --version

# Rust through rustup. RUST_TOOLCHAIN is the channel in rust-toolchain.toml
# (scripts/linux-package.mjs passes it), with the components that file lists.
ARG RUST_TOOLCHAIN=stable
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN set -eu; \
  curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh; \
  sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain none; \
  rm /tmp/rustup-init.sh; \
  rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt,clippy; \
  rustup default "$RUST_TOOLCHAIN"; \
  chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"; \
  rustc --version; cargo --version

# Inspection only: read the built .rpm's metadata and validate the .desktop entry.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y rpm desktop-file-utils \
  && rm -rf /var/lib/apt/lists/*

# Build as an ordinary user: tests about file permissions mean nothing as root, and
# nobody runs the app as root.
RUN useradd --create-home --uid 1001 --shell /bin/bash builder
USER builder
WORKDIR /home/builder
# AppImage tools are themselves AppImages; containers have no FUSE to mount them.
ENV APPIMAGE_EXTRACT_AND_RUN=1 \
    NO_AT_BRIDGE=1 \
    QT_QPA_PLATFORM=offscreen
