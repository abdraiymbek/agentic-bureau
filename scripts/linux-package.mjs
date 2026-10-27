#!/usr/bin/env node
/**
 * Build, test and run the Linux packages (deb, rpm, AppImage) in containers.
 *
 *   node scripts/linux-package.mjs [--skip-tests] [--skip-build] [--skip-verify]
 *                                  [--keep-going] [--keep]
 *
 * 1. Builds the `bureau-linux-build` image from scripts/linux/Dockerfile: Ubuntu 22.04
 *    (glibc 2.35, the compatibility floor) with Tauri's libraries, Node, pnpm, Rust (the
 *    channel in rust-toolchain.toml), Ubuntu's OpenSCAD 2021.01 (the Rust engine tests
 *    require it), Xvfb and xdotool.
 * 2. Copies the working tree (the files git tracks or would track, without videos/)
 *    into a container of that image. Never a bind mount: node_modules and target/ on the
 *    host hold the host's own binaries. As an ordinary user it runs the install, the
 *    contracts check, the helper build, the Rust tests, the conformance suite, the
 *    headless smoke (all skipped by --skip-tests), then
 *    `pnpm make --bundles deb,rpm,appimage`, and checks the glibc version both packages
 *    declare against the newest glibc symbol the app, the helper and everything in the
 *    AppImage use.
 * 3. Copies the packages to target/release/bundle/linux-<arch>/ (the Debian architecture
 *    name: arm64, amd64), which is emptied first.
 * 4. Runs each package on systems that have never seen the build: the .deb installed with
 *    apt on fresh Ubuntu 22.04, Ubuntu 24.04 and Debian 12, the AppImage on a fresh
 *    Ubuntu 22.04 with no WebKitGTK or GTK, the .rpm installed with dnf on a fresh
 *    Fedora 42. apt and dnf must bring every library the app links; then the packaged
 *    smoke runs against it under Xvfb (window, helper, bridge, grant round trip, a
 *    stand-in agent in the Agent tab, a WebKitGTK picture of the page, and a SIGTERM that
 *    must quit with status 0 and end the agent's process group).
 *
 * --skip-build verifies the packages already in the output folder. --keep-going runs
 * every test and smoke step and fails at the end. Containers are named bureau-linux-*
 * and are removed at the end, also when a step fails, unless --keep. The image is kept.
 * DOCKER_CONTEXT selects the Docker daemon (for example colima-omenflow).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Set(process.argv.slice(2));
for (const option of options)
  if (!['--skip-tests', '--skip-build', '--skip-verify', '--keep-going', '--keep'].includes(option))
    throw new Error(`Unknown option ${option}`);

const IMAGE = 'bureau-linux-build';
/** The oldest supported system first: the build base itself. */
const DEB_SYSTEMS = ['ubuntu:22.04', 'ubuntu:24.04', 'debian:12'];
const APPIMAGE_SYSTEMS = ['ubuntu:22.04'];
const RPM_SYSTEMS = ['fedora:42'];
const BUILD_CONTAINER = 'bureau-linux-build-run';
const SOURCE = '/home/builder/agentic-bureau';
const SCREEN = '-screen 0 1920x1080x24';
const results = [];
const started = new Set();
let failed = false;

function run(command, args, { input, capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

const docker = (args, options) => run('docker', args, options);
const output = (args) => docker(args, { capture: true }).stdout.trim();

/** Run a shell script in a container, timed and recorded. */
function step(container, label, script, { user = 'root', workdir = '/', test = false } = {}) {
  console.log(`\n==> ${label}\n    ${script}`);
  const begun = Date.now();
  const result = docker(['exec', '-u', user, '-w', workdir, container, 'bash', '-ec', script], {
    allowFailure: true,
  });
  const seconds = Math.round((Date.now() - begun) / 1000);
  results.push({ label, status: result.status, seconds });
  console.log(`<== ${label}: exit ${result.status} after ${seconds} s`);
  if (result.status !== 0) {
    failed = true;
    if (!(test && options.has('--keep-going')))
      throw new Error(`${label} failed (exit ${result.status})`);
  }
}

function remove(name) {
  docker(['rm', '-f', name], { capture: true, allowFailure: true });
  started.delete(name);
}

function fresh(name, image) {
  remove(name);
  docker(['run', '-d', '--init', '--name', name, image, 'sleep', 'infinity'], { capture: true });
  started.add(name);
}

/** A container name for a package on a system: bureau-linux-deb-ubuntu-22.04. */
const containerFor = (kind, system) => `bureau-linux-${kind}-${system.replace(/[:/]/g, '-')}`;

/** The files git tracks or would track: no node_modules, target/, .git or other ignored output. */
function sourceFiles() {
  const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    capture: true,
  }).stdout.split('\0');
  return listed.filter(
    (file) =>
      file &&
      !['videos/', '.claude/', '.codex/'].some((prefix) => file.startsWith(prefix)) &&
      existsSync(path.join(root, file)),
  );
}

function copySources(container) {
  const files = sourceFiles();
  console.log(`\n==> Copy ${files.length} source files into ${container}:${SOURCE}`);
  docker(['exec', '-u', 'builder', container, 'mkdir', '-p', SOURCE]);
  // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble files.
  const tar = spawn('tar', ['-c', '--no-xattrs', '--null', '-T', '-', '-f', '-'], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const unpack = spawn(
    'docker',
    ['exec', '-i', '-u', 'builder', container, 'tar', '-x', '-C', SOURCE, '-f', '-'],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  tar.stdout.pipe(unpack.stdin);
  tar.stdin.end(files.join('\0'));
  return Promise.all(
    [tar, unpack].map(
      (child) =>
        new Promise((resolve, reject) =>
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`source copy failed (${code})`)),
          ),
        ),
    ),
  );
}

function toolchainChannel() {
  const text = readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8');
  return text.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1] ?? 'stable';
}

/**
 * The floors the packages declare. Both must name the same glibc (`libc6 (>= X)`, and
 * `libc.so.6(GLIBC_X)(64bit)`, the rpm form, since Tauri writes rpm requirements without
 * version comparisons), no older than the newest glibc symbol the app, the helper or
 * anything inside the AppImage uses, and no newer than the build base's own glibc. The
 * .deb's minimum glibc and WebKitGTK must also be at least what dpkg-shlibdeps derives
 * from the binaries' symbols (Ubuntu 22.04's release pocket has WebKitGTK 2.36).
 */
const DECLARED_FLOORS = (bundle) => String.raw`set -euo pipefail
deb=$(ls ${bundle}/deb/*.deb); rpm=$(ls ${bundle}/rpm/*.rpm); appimage=$(ls ${bundle}/appimage/*.AppImage)
work=$(mktemp -d)
fail() { echo "declared floors: $*" >&2; exit 1; }
newest() { grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -uV | tail -n 1; }
minimum() { printf '%s' "$1" | tr ',' '\n' | sed -n "s/^ *$2 (>= \([^)]*\)).*/\1/p" | head -n 1; }
dpkg-deb -x "$deb" "$work/deb"
app="$work/deb/usr/bin/agentic-bureau"; helper="$work/deb/usr/lib/Bureau/bureau"
app_glibc=$(objdump -T "$app" | newest); helper_glibc=$(objdump -T "$helper" | newest)
need=$(printf '%s\n%s\n' "$app_glibc" "$helper_glibc" | sort -V | tail -n 1)
(cd "$work" && env -u APPIMAGE_EXTRACT_AND_RUN "$appimage" --appimage-extract > /dev/null)
bundled=$({ find "$work/squashfs-root" -type f -exec objdump -T {} + 2> /dev/null || true; } | newest)
base=$(dpkg-query -W -f='${'${Version}'}' libc6 | sed 's/-.*//')
declared=$(dpkg-deb --field "$deb" Depends)
deb_glibc=$(minimum "$declared" libc6)
rpm_glibc=$(rpm -qp --requires "$rpm" | sed -n 's/^libc\.so\.6(GLIBC_\([0-9.]*\))(64bit) *$/\1/p' | sort -V | tail -n 1)
mkdir -p "$work/source/debian"
printf 'Source: agentic-bureau\n\nPackage: agentic-bureau\nArchitecture: any\n' > "$work/source/debian/control"
derived=$(cd "$work/source" && dpkg-shlibdeps -O "$app" "$helper" 2> /dev/null | sed -n 's/^shlibs:Depends=//p')
echo "newest glibc symbol used: app GLIBC_$app_glibc, helper GLIBC_$helper_glibc, anything in the AppImage GLIBC_$bundled; build base glibc $base"
echo ".deb Depends: $declared"
echo ".rpm glibc: libc.so.6(GLIBC_$rpm_glibc)(64bit)"
echo "dpkg-shlibdeps on the app and the helper: $derived"
[ -n "$deb_glibc" ] || fail "the .deb declares no libc6 (>= ...)"
[ -n "$rpm_glibc" ] || fail "the .rpm requires no libc.so.6(GLIBC_...)(64bit)"
[ "$deb_glibc" = "$rpm_glibc" ] || fail "the .deb ($deb_glibc) and the .rpm ($rpm_glibc) declare different glibc floors"
dpkg --compare-versions "$need" le "$deb_glibc" || fail "the binaries use GLIBC_$need, newer than the declared $deb_glibc"
dpkg --compare-versions "$bundled" le "$deb_glibc" || fail "the AppImage uses GLIBC_$bundled, newer than the declared $deb_glibc"
dpkg --compare-versions "$deb_glibc" le "$base" || fail "the declared glibc $deb_glibc is newer than the build base's $base"
for package in libc6 libwebkit2gtk-4.1-0; do
  have=$(minimum "$declared" "$package"); wanted=$(minimum "$derived" "$package")
  [ -n "$have" ] || fail "the .deb declares no minimum $package (dpkg-shlibdeps: >= $wanted)"
  [ -z "$wanted" ] || dpkg --compare-versions "$have" ge "$wanted" || fail "the .deb declares $package (>= $have); the binaries need >= $wanted"
done
if [ "$deb_glibc" = "$need" ]; then echo "glibc floor $deb_glibc: declared by both packages, and exactly what the binaries need"
else echo "glibc floor $deb_glibc: declared by both packages; the binaries need only $need"; fi
rm -rf "$work"`;

async function build(outDir) {
  const container = BUILD_CONTAINER;
  fresh(container, IMAGE);
  await copySources(container);
  const inSource = { user: 'builder', workdir: SOURCE };
  step(
    container,
    'Tool versions',
    'node --version; pnpm --version; rustc --version; cargo --version; ' +
      'openscad --version 2>&1; ldd --version | head -n 1; ' +
      '. /etc/os-release; echo "$PRETTY_NAME $(dpkg --print-architecture)"',
    inSource,
  );
  step(container, 'Install the workspace', 'pnpm install --frozen-lockfile', inSource);
  if (!options.has('--skip-tests')) {
    const tests = [
      ['Rebuild node-pty', 'pnpm rebuild:node'],
      ['Contracts registry', 'pnpm contracts:check'],
      ['Helper (release)', 'pnpm build:bridge'],
      ['Rust workspace tests', 'cargo test --workspace --locked --no-fail-fast'],
      ['Helper tests', 'cargo test --locked --manifest-path native/bureau-bridge/Cargo.toml'],
      ['Real-helper round trip', 'cargo test -p bureau-agent-host --locked -- --ignored'],
      ['Conformance suite', 'pnpm test:conformance'],
      ['Headless smoke', 'pnpm smoke:headless'],
    ];
    for (const [label, script] of tests)
      step(container, label, script, { ...inSource, test: true });
  }
  // Tauri fetches linuxdeploy for the AppImage; APPIMAGE_EXTRACT_AND_RUN (set in the
  // image) lets those tools run without FUSE.
  step(container, 'Packages', 'pnpm make --bundles deb,rpm,appimage', inSource);
  const bundle = `${SOURCE}/target/release/bundle`;
  const packages = output([
    'exec',
    container,
    'sh',
    '-c',
    `ls ${bundle}/deb/*.deb ${bundle}/rpm/*.rpm ${bundle}/appimage/*.AppImage`,
  ]).split('\n');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const file of packages) docker(['cp', `${container}:${file}`, outDir]);
  step(
    container,
    'Package metadata',
    [
      `dpkg-deb --info ${bundle}/deb/*.deb`,
      `dpkg-deb --contents ${bundle}/deb/*.deb`,
      `dpkg-deb --fsys-tarfile ${bundle}/deb/*.deb | tar -xO --wildcards '*.desktop' | tee /tmp/entry.desktop`,
      'desktop-file-validate /tmp/entry.desktop && echo "desktop-file-validate: no errors"',
      `rpm -qip ${bundle}/rpm/*.rpm`,
      `rpm -qp --requires ${bundle}/rpm/*.rpm`,
      `rpm -qlp ${bundle}/rpm/*.rpm`,
    ].join('; '),
    inSource,
  );
  step(container, 'Declared glibc and WebKitGTK floors', DECLARED_FLOORS(bundle), inSource);
  if (!options.has('--keep')) remove(container);
}

function packageIn(outDir, suffix) {
  const found = readdirSync(outDir).filter((name) => name.endsWith(suffix));
  if (found.length !== 1) throw new Error(`Expected one ${suffix} in ${outDir}, found ${found}`);
  return found[0];
}

/**
 * The build image's Node, which runs the smoke on every system: Ubuntu 22.04's own
 * nodejs is version 12, too old for the script. Its official binary needs glibc 2.28.
 */
function smokeNode(dir) {
  const name = 'bureau-linux-node';
  remove(name);
  docker(['create', '--name', name, IMAGE], { capture: true });
  started.add(name);
  try {
    docker(['cp', `${name}:/usr/local/bin/node`, path.join(dir, 'node')]);
  } finally {
    remove(name);
  }
  return path.join(dir, 'node');
}

/** Put a package, the smoke script and Node into /tmp/pkg of a container. */
function stage(container, outDir, file, node) {
  docker(['exec', container, 'mkdir', '-p', '/tmp/pkg']);
  docker(['cp', path.join(outDir, file), `${container}:/tmp/pkg/${file}`]);
  docker(['cp', path.join(root, 'scripts/rust-packaged-smoke.mjs'), `${container}:/tmp/pkg/`]);
  docker(['cp', node, `${container}:/tmp/pkg/node`]);
  docker(['exec', container, 'chmod', '-R', 'a+rX', '/tmp/pkg']);
}

/** Nothing the app or its helper links may be missing. */
const LINKED = (files) =>
  `for f in ${files}; do echo "ldd $f"; ldd "$f" | tee /tmp/ldd.txt | grep -c . ; ` +
  `if grep 'not found' /tmp/ldd.txt; then exit 1; fi; done`;

/** The smoke as an ordinary user on a fresh virtual display, with a screenshot. */
function smoke(container, label, executable, screenshot, env = '') {
  step(container, 'Create an ordinary user', 'id tester || useradd --create-home tester');
  step(
    container,
    label,
    `cd ~ && ${env} xvfb-run -a -s '${SCREEN}' /tmp/pkg/node /tmp/pkg/rust-packaged-smoke.mjs ` +
      `--linux '${executable}' --screenshot /tmp/${screenshot}.png`,
    { user: 'tester', workdir: '/home/tester', test: true },
  );
}

/** The X screen, and the page as the app pictured it (WebKitGTK), both saved by the smoke. */
function screenshot(container, outDir, name) {
  for (const file of [`${name}.png`, `${name}-webview.png`])
    docker(['cp', `${container}:/tmp/${file}`, path.join(outDir, file)], {
      capture: true,
      allowFailure: true,
    });
}

const APT = 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y --no-install-recommends';
const DISPLAY_TOOLS = 'xvfb xauth xdotool x11-utils x11-apps';
/** EGL, OpenGL ES and GL (WebKit loads them at run time), HarfBuzz and FriBidi. */
const APPIMAGE_HOST_LIBS = 'libegl1 libegl-mesa0 libgles2 libgl1 libharfbuzz0b libfribidi0';

function verifyDeb(outDir, system, node) {
  const container = containerFor('deb', system);
  const deb = packageIn(outDir, '.deb');
  const tag = `smoke-deb-${system.replace(/[:/]/g, '-')}`;
  fresh(container, system);
  stage(container, outDir, deb, node);
  step(
    container,
    `apt install the .deb on a fresh ${system}`,
    `. /etc/os-release && echo "$PRETTY_NAME, $(ldd --version | head -n 1)" && ` +
      `apt-get update -q && ${APT} '/tmp/pkg/${deb}'`,
  );
  const name = output(['exec', container, 'dpkg-deb', '--field', `/tmp/pkg/${deb}`, 'Package']);
  const executable = output(['exec', container, 'sh', '-c', `dpkg -L ${name} | grep '^/usr/bin/'`]);
  step(
    container,
    `Installed files and linked libraries (.deb, ${system})`,
    `dpkg -L ${name}; dpkg -s ${name}; ` + LINKED(`${executable} "/usr/lib/Bureau/bureau"`),
  );
  step(container, 'Display tools for the smoke', `${APT} ${DISPLAY_TOOLS}`);
  smoke(container, `Packaged smoke (installed .deb, ${system})`, executable, tag);
  screenshot(container, outDir, tag);
  step(container, 'apt remove', `apt-get remove -y ${name} && ! test -e '${executable}'`);
  if (!options.has('--keep')) remove(container);
}

function verifyAppImage(outDir, system, node) {
  const container = containerFor('appimage', system);
  const appimage = packageIn(outDir, '.AppImage');
  const tag = `smoke-appimage-${system.replace(/[:/]/g, '-')}`;
  fresh(container, system);
  stage(container, outDir, appimage, node);
  // The display tools, and the libraries an AppImage leaves to the host because they
  // belong to its graphics driver or text stack (they are on the AppImage exclude
  // list; every desktop with GTK has them). WebKitGTK and GTK must come from the image.
  step(
    container,
    `Display tools and host graphics libraries only (no WebKitGTK, no GTK) on ${system}`,
    `. /etc/os-release && echo "$PRETTY_NAME, $(ldd --version | head -n 1)" && ` +
      `apt-get update -q && ${APT} ${DISPLAY_TOOLS} ${APPIMAGE_HOST_LIBS}`,
  );
  step(
    container,
    'No WebKitGTK or GTK on this system',
    `! ls /usr/lib/*/libwebkit2gtk-4.1.so.0 /usr/lib/*/libgtk-3.so.0 2>/dev/null && chmod 755 '/tmp/pkg/${appimage}'`,
  );
  // Containers have no FUSE: the AppImage unpacks itself instead of mounting.
  smoke(
    container,
    `Packaged smoke (AppImage, ${system})`,
    `/tmp/pkg/${appimage}`,
    tag,
    'APPIMAGE_EXTRACT_AND_RUN=1',
  );
  screenshot(container, outDir, tag);
  if (!options.has('--keep')) remove(container);
}

function verifyRpm(outDir, system, node) {
  const container = containerFor('rpm', system);
  const rpm = packageIn(outDir, '.rpm');
  const tag = `smoke-rpm-${system.replace(/[:/]/g, '-')}`;
  fresh(container, system);
  stage(container, outDir, rpm, node);
  step(
    container,
    `dnf install the .rpm on a fresh ${system}`,
    `. /etc/os-release && echo "$PRETTY_NAME, $(ldd --version | head -n 1)" && ` +
      `dnf install -y -q '/tmp/pkg/${rpm}'`,
  );
  const name = output(['exec', container, 'rpm', '-qp', '--qf', '%{NAME}', `/tmp/pkg/${rpm}`]);
  const executable = output(['exec', container, 'sh', '-c', `rpm -ql ${name} | grep '^/usr/bin/'`]);
  step(
    container,
    `Installed files and linked libraries (.rpm, ${system})`,
    `rpm -qi ${name}; rpm -ql ${name}; ` + LINKED(`${executable} "/usr/lib/Bureau/bureau"`),
  );
  step(
    container,
    'Display tools for the smoke',
    'dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xdotool xwininfo xprop xwd',
  );
  smoke(container, `Packaged smoke (installed .rpm, ${system})`, executable, tag);
  screenshot(container, outDir, tag);
  if (!options.has('--keep')) remove(container);
}

const begun = Date.now();
const scratch = mkdtempSync(path.join(tmpdir(), 'bureau-linux-'));
try {
  docker([
    'build',
    '-t',
    IMAGE,
    '--build-arg',
    `RUST_TOOLCHAIN=${toolchainChannel()}`,
    path.join(root, 'scripts/linux'),
  ]);
  const arch = output(['run', '--rm', IMAGE, 'dpkg', '--print-architecture']);
  const outDir = path.join(root, 'target/release/bundle', `linux-${arch}`);
  if (!options.has('--skip-build')) await build(outDir);
  if (!options.has('--skip-verify')) {
    const node = smokeNode(scratch);
    for (const system of DEB_SYSTEMS) verifyDeb(outDir, system, node);
    for (const system of APPIMAGE_SYSTEMS) verifyAppImage(outDir, system, node);
    for (const system of RPM_SYSTEMS) verifyRpm(outDir, system, node);
  }
  console.log(`\nPackages in ${outDir}:`);
  for (const name of readdirSync(outDir))
    console.log(`  ${name} ${statSync(path.join(outDir, name)).size} bytes`);
} finally {
  if (!options.has('--keep')) for (const name of [...started]) remove(name);
  rmSync(scratch, { recursive: true, force: true });
  console.log('\nSteps:');
  for (const { label, status, seconds } of results)
    console.log(`  ${status === 0 ? 'ok  ' : 'FAIL'} ${label} (${seconds} s)`);
  console.log(`Total ${Math.round((Date.now() - begun) / 1000)} s`);
}
if (failed) {
  console.error('linux-package: a step failed');
  process.exit(1);
}
console.log('linux-package: all steps passed');
