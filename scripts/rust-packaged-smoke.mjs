#!/usr/bin/env node
/**
 * Prove a build end to end through the `omenflow` helper an agent CLI uses.
 *
 *   node scripts/rust-packaged-smoke.mjs [path/to/Omen Flow.app]
 *     Launches the bundle with disposable state. The app is asked (through
 *     OMENFLOW_SMOKE_PROJECT, honoured only with OMENFLOW_APP_DATA_DIR) to
 *     create a project and hand over the agent grant a terminal session
 *     would receive.
 *   node scripts/rust-packaged-smoke.mjs --linux <executable> [--screenshot <file.png>]
 *     The same on Linux, against an installed package's executable
 *     (`/usr/bin/omen-flow` after `apt install ./omen-flow_*.deb`) or an
 *     AppImage, on an X display (run it under `xvfb-run`). The helper is the
 *     one the app itself resolved and would put on an agent's PATH, so this
 *     also proves where the package keeps it. It then requires a visible
 *     top-level "Omen Flow" window of at least the minimum size (xdotool,
 *     xwininfo) and that the app is still running afterwards. The app also
 *     starts a stand-in agent CLI in the Agent tab (a real PTY in its own
 *     process group, which must reach the bridge through the helper on its
 *     PATH) and pictures its own page the way the research screenshot does
 *     (WebKitGTK), which must match the window. Last, the app is sent
 *     SIGTERM: it must quit through its exit path with status 0, ending the
 *     agent's process group and, for a mounted AppImage, releasing the mount.
 *     With --screenshot it also saves the X screen (xwd) and the page picture
 *     (`<file>-webview.png`) as PNGs.
 *   node scripts/rust-packaged-smoke.mjs --headless
 *     The same checks against the development `omenflow-host` and helper,
 *     with no bundle and no window.
 *
 * All check that the helper prints its usage, that the bridge refuses an
 * unknown token, and that a valid grant really works: the helper reads the
 * project, writes a draft attributed to the agent, reads it back, and is
 * refused a human-only operation.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT_NAME = 'Packaged smoke';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkUsage(helper) {
  const usage = spawnSync(helper, [], { encoding: 'utf8' });
  check(
    usage.status === 3 &&
      usage.stderr.includes('omenflow call') &&
      usage.stderr.includes('omenflow mcp'),
    'The omenflow helper does not print its usage',
  );
}

/** Send one hello with a made-up token and return the bridge's answer. */
function helloWithInvalidToken(socket) {
  return new Promise((resolve, reject) => {
    const stream = createConnection(socket);
    let buffer = Buffer.alloc(0);
    stream.on('error', reject);
    stream.on('connect', () => {
      const frame = Buffer.from(
        JSON.stringify({ type: 'hello', protocolVersion: 1, token: 'invalid', mode: 'call' }),
      );
      const size = Buffer.alloc(4);
      size.writeUInt32LE(frame.length);
      stream.write(Buffer.concat([size, frame]));
    });
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        stream.destroy();
        resolve(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString()));
      }
    });
    setTimeout(() => reject(new Error('Bridge did not answer')), 5000).unref();
  });
}

/** Run `omenflow call <op>` with the session's environment. */
function helperCall(helper, grant, op, payload) {
  const run = spawnSync(helper, ['call', op, '--input', '-'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      OMENFLOW_BRIDGE_SOCK: grant.socketPath,
      OMENFLOW_BRIDGE_TOKEN: grant.token,
      OMENFLOW_PROJECT_ID: grant.projectId,
      OMENFLOW_SESSION_ID: grant.sessionId,
    },
  });
  if (run.status === 0) return { ok: true, result: JSON.parse(run.stdout) };
  const failure = run.stderr.trim().split('\n').at(-1) ?? '';
  try {
    return { ok: false, status: run.status, error: JSON.parse(failure).error };
  } catch {
    return { ok: false, status: run.status, error: { code: 'UNKNOWN', message: run.stderr } };
  }
}

async function agentRoundTrip(helper, grant) {
  const denial = await helloWithInvalidToken(grant.socketPath);
  check(
    denial.error?.code === 'CONNECTION_DENIED',
    `Unexpected unauthenticated bridge response: ${JSON.stringify(denial)}`,
  );
  const summary = helperCall(helper, grant, 'project.summary', {});
  check(summary.ok, `project.summary failed: ${JSON.stringify(summary.error)}`);
  check(
    summary.result.project?.name === PROJECT_NAME && summary.result.project?.id === grant.projectId,
    `project.summary read the wrong project: ${JSON.stringify(summary.result.project)}`,
  );
  const draft = helperCall(helper, grant, 'artifact.create_draft', {
    type: 'note',
    title: 'Smoke note',
    payload: { markdown: 'Written by the smoke test through the omenflow helper.' },
  });
  check(draft.ok, `artifact.create_draft failed: ${JSON.stringify(draft.error)}`);
  check(
    draft.result.revision?.origin === 'agent' && draft.result.revision?.reviewState === 'draft',
    `The draft is not an agent draft: ${JSON.stringify(draft.result.revision)}`,
  );
  const listed = helperCall(helper, grant, 'artifact.list', {});
  check(listed.ok, `artifact.list failed: ${JSON.stringify(listed.error)}`);
  check(
    listed.result.artifacts?.some((view) => view.artifact.id === draft.result.artifact.id),
    'The agent draft is missing from artifact.list',
  );
  const approve = helperCall(helper, grant, 'proposal.approve', {
    proposalId: '00000000-0000-4000-8000-000000000001',
  });
  check(
    !approve.ok && approve.status === 2 && approve.error?.code === 'CAPABILITY_DENIED',
    `An agent was not refused proposal.approve: ${JSON.stringify(approve)}`,
  );
  console.log('rust-packaged-smoke: helper round trip passed (read, agent draft, refusal)');
}

async function untilExists(file, process_, limitMs) {
  const until = Date.now() + limitMs;
  while (!existsSync(file) && process_.exitCode === null && Date.now() < until) await sleep(100);
  return existsSync(file);
}

async function stop(process_) {
  if (process_.exitCode !== null || process_.signalCode !== null) return;
  process_.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => process_.once('exit', resolve)), sleep(5000)]);
}

async function smokeBundle(app) {
  const executable = path.join(app, 'Contents/MacOS/omenflow-rust-desktop');
  const helper = path.join(app, 'Contents/Resources/omenflow');
  if (!existsSync(executable) || !existsSync(helper))
    throw new Error(`Incomplete Rust bundle: ${app}`);
  // Short: the bridge socket lives inside, and socket paths have a length limit.
  const scratch = mkdtempSync(path.join(tmpdir(), 'omf-smoke-'));
  const appData = path.join(scratch, 'app');
  const grantFile = path.join(appData, 'run/smoke-grant.json');
  console.log('rust-packaged-smoke: launching');
  const process_ = spawn(executable, [], {
    env: {
      ...process.env,
      OMENFLOW_APP_DATA_DIR: appData,
      OMENFLOW_SMOKE_PROJECT: path.join(scratch, 'project'),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    if (!(await untilExists(grantFile, process_, 20000)))
      throw new Error(
        process_.exitCode === null
          ? 'The app did not hand over an agent grant within 20 seconds'
          : `The app exited with code ${process_.exitCode} before handing over an agent grant`,
      );
    const grant = JSON.parse(readFileSync(grantFile, 'utf8'));
    if (grant.error) throw new Error(`The app could not prepare the smoke project: ${grant.error}`);
    console.log(`rust-packaged-smoke: bridge at ${grant.socketPath}`);
    // The helper agents get: the bundled one, or the app's own copy in its data folder when
    // the bundled one carries the quarantine flag of an unnotarized download (src/helper.rs).
    const agentHelper = grant.cliPath ?? helper;
    check(
      agentHelper === helper || agentHelper === path.join(appData, 'bin/omenflow'),
      `The app hands agents an unexpected helper: ${agentHelper}`,
    );
    if (agentHelper !== helper) console.log(`rust-packaged-smoke: agents use ${agentHelper}`);
    checkUsage(agentHelper);
    await agentRoundTrip(agentHelper, grant);
    check(process_.exitCode === null, 'The app exited during the smoke');
    console.log(`Rust bundle smoke passed: ${app}`);
  } finally {
    await stop(process_);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `productName` in tauri.conf.json: the package keeps its resources in `lib/<productName>/`. */
const PRODUCT_NAME = 'Omen Flow';
/** The main window's minimum size in tauri.conf.json. */
const MIN_WINDOW = { width: 1024, height: 700 };

function tool(name, args) {
  const run = spawnSync(name, args, { encoding: 'utf8' });
  if (run.error) throw new Error(`${name} is not available (${run.error.code})`);
  return run;
}

/** Visible top-level windows titled "Omen Flow", with their geometry. */
function appWindows() {
  const search = tool('xdotool', ['search', '--onlyvisible', '--name', `^${PRODUCT_NAME}$`]);
  return search.stdout
    .split('\n')
    .filter(Boolean)
    .map((id) => {
      const info = tool('xwininfo', ['-id', id]).stdout;
      const field = (label) => info.match(new RegExp(`${label}:\\s+(.+)`))?.[1]?.trim();
      return {
        id,
        width: Number(field('Width')),
        height: Number(field('Height')),
        mapState: field('Map State'),
        pid: tool('xdotool', ['getwindowpid', id]).stdout.trim() || null,
        wmClass: tool('xprop', ['-id', id, 'WM_CLASS']).stdout.split('=')[1]?.trim() ?? null,
      };
    });
}

async function untilWindow(limitMs) {
  const until = Date.now() + limitMs;
  for (;;) {
    const windows = appWindows().filter(
      (window) =>
        window.mapState === 'IsViewable' &&
        window.width >= MIN_WINDOW.width &&
        window.height >= MIN_WINDOW.height,
    );
    if (windows.length > 0 || Date.now() > until) return windows;
    await sleep(250);
  }
}

/**
 * What a child of the app inherits (the login shell it asks for the PATH):
 * no AppImage runtime variables and, from an AppImage, nothing that points
 * into the unpacked image (`image`), whose launcher sets LD_LIBRARY_PATH,
 * PYTHONHOME, GTK paths and more for the app itself. A child does not start
 * inside the image either.
 */
async function checkChildEnvironment(file, image, process_) {
  check(
    await untilExists(file, process_, 10000),
    'The app did not start its login-shell PATH probe',
  );
  const vars = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  const inside = (value) =>
    value
      .split(':')
      .some(
        (entry) =>
          entry.startsWith('/') &&
          (path.resolve(entry) === image || path.resolve(entry).startsWith(`${image}/`)),
      );
  const leaked = vars.filter(
    ([key, value]) =>
      ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'].includes(key) || (image !== null && inside(value)),
  );
  check(
    leaked.length === 0,
    `A child of the app inherited the package's own environment: ${leaked.map(([key]) => key).join(', ')}`,
  );
  console.log(
    `rust-packaged-smoke: child environment clean (${vars.length} variables, ${
      image ? `none inside ${image}` : 'no AppImage variables'
    })`,
  );
}

/** Resolves true once the process has ended, false after `limitMs`. */
function ended(process_, limitMs) {
  if (process_.exitCode !== null || process_.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => process_.once('exit', () => resolve(true))),
    sleep(limitMs).then(() => false),
  ]);
}

/** Whether any process of the group `pgid` is left (zombies are reaped by the init). */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Process group and session of a running process, from /proc. */
function groupOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pgid: Number(fields[2]), sid: Number(fields[3]) };
}

/**
 * The stand-in agent CLI the app starts in the Agent tab. Like a real one it
 * finds `omenflow` on the PATH its session gets, calls the bridge with the
 * session's credentials, and then waits, here with a child of its own so the
 * whole process group has to end.
 */
function writeStandInAgent(file, out) {
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `out='${out}'`,
      '{',
      '  echo "pid $$"',
      '  echo "helper $(command -v omenflow)"',
      '  printf "{}" | omenflow call project.summary --input - > "$out.summary" 2>&1',
      '  echo "status $?"',
      '} > "$out.partial" && mv "$out.partial" "$out"',
      'sleep 600 &',
      'wait',
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The width and height a PNG file declares, or null when it is not a PNG. */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), data]))
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * An xwd dump of a TrueColor or DirectColor screen (16, 24 or 32 bits per
 * pixel) as an RGB PNG. Converted here because Ubuntu 22.04's `xwdtopnm`
 * misreads Xvfb's 32-bit dumps, and so no image tools need installing.
 */
function xwdToPng(xwd, png) {
  const file = readFileSync(xwd);
  const field = (index) => file.readUInt32BE(index * 4);
  const [headerSize, format, width, height] = [field(0), field(2), field(4), field(5)];
  const [byteOrder, bitsPerPixel, bytesPerLine, visualClass] = [7, 11, 12, 13].map(field);
  if (format !== 2 || ![16, 24, 32].includes(bitsPerPixel) || ![4, 5].includes(visualClass))
    throw new Error(
      `Unsupported xwd dump: format ${format}, ${bitsPerPixel} bits per pixel, visual class ${visualClass}`,
    );
  const channels = [field(14), field(15), field(16)].map((mask) => {
    const shift = 31 - Math.clz32(mask & -mask);
    return { mask, shift, max: mask >>> shift };
  });
  const start = headerSize + field(19) * 12;
  const bytes = bitsPerPixel / 8;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = start + y * bytesPerLine + x * bytes;
      let pixel = 0;
      for (let i = 0; i < bytes; i++)
        pixel = byteOrder === 0 ? pixel | (file[at + i] << (8 * i)) : (pixel << 8) | file[at + i];
      channels.forEach(({ mask, shift, max }, c) => {
        raw[y * stride + 1 + x * 3 + c] = Math.round((((pixel & mask) >>> shift) * 255) / max);
      });
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  writeFileSync(
    png,
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Everything the launched process started (an AppImage runtime forks the app). */
function killTree(process_, signal) {
  try {
    process.kill(-process_.pid, signal);
  } catch {
    // Already gone.
  }
}

async function smokeLinux(executable, screenshot) {
  check(existsSync(executable), `No executable at ${executable}`);
  check(process.env.DISPLAY, 'The Linux smoke needs an X display: run it under xvfb-run');
  tool('xdotool', ['version']);
  tool('xwininfo', ['-version']);
  const scratch = mkdtempSync(path.join(tmpdir(), 'omf-smoke-'));
  const appData = path.join(scratch, 'app');
  const grantFile = path.join(appData, 'run/smoke-grant.json');
  // The app asks the login shell for the person's PATH as it starts. A shell
  // that records its environment shows what the app's children get.
  const shell = path.join(scratch, 'shell');
  const childEnv = path.join(scratch, 'child-env.txt');
  writeFileSync(
    shell,
    '#!/bin/sh\nenv > "$OMF_SMOKE_CHILD_ENV.partial" && mv "$OMF_SMOKE_CHILD_ENV.partial" "$OMF_SMOKE_CHILD_ENV"\nexec /bin/sh "$@"\n',
  );
  chmodSync(shell, 0o755);
  const agent = path.join(scratch, 'agent');
  const agentOut = path.join(scratch, 'agent.txt');
  writeStandInAgent(agent, agentOut);
  const snapshot = path.join(appData, 'run/smoke-snapshot.png');
  const snapshotFailure = path.join(appData, 'run/smoke-snapshot.txt');
  console.log(`rust-packaged-smoke: launching ${executable}`);
  const process_ = spawn(executable, [], {
    env: {
      ...process.env,
      OMENFLOW_APP_DATA_DIR: appData,
      OMENFLOW_SMOKE_PROJECT: path.join(scratch, 'project'),
      OMENFLOW_SMOKE_AGENT: agent,
      OMENFLOW_SMOKE_SNAPSHOT: '1',
      SHELL: shell,
      OMF_SMOKE_CHILD_ENV: childEnv,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    // Its own process group, so the smoke can stop all of it.
    detached: true,
  });
  try {
    // An AppImage without FUSE unpacks itself first.
    if (!(await untilExists(grantFile, process_, 60000)))
      throw new Error(
        process_.exitCode === null
          ? 'The app did not hand over an agent grant within 60 seconds'
          : `The app exited with code ${process_.exitCode} before handing over an agent grant`,
      );
    const grant = JSON.parse(readFileSync(grantFile, 'utf8'));
    if (grant.error) throw new Error(`The app could not prepare the smoke project: ${grant.error}`);
    console.log(`rust-packaged-smoke: bridge at ${grant.socketPath}`);
    const helper = grant.cliPath;
    console.log(`rust-packaged-smoke: helper the app resolved: ${helper}`);
    check(
      typeof helper === 'string' &&
        helper.endsWith(`/lib/${PRODUCT_NAME}/omenflow`) &&
        existsSync(helper) &&
        !helper.includes('/native/omenflow-bridge/'),
      `The app did not resolve the packaged helper: ${helper}`,
    );
    if (!executable.endsWith('.AppImage')) {
      const installed = path.resolve(
        path.dirname(realpathSync(executable)),
        `../lib/${PRODUCT_NAME}/omenflow`,
      );
      check(
        realpathSync(helper) === realpathSync(installed),
        `The helper is not the installed ${installed}: ${helper}`,
      );
    }
    checkUsage(helper);
    await agentRoundTrip(helper, grant);
    const image = executable.endsWith('.AppImage') ? path.resolve(helper, '../../../..') : null;
    await checkChildEnvironment(childEnv, image, process_);
    const windows = await untilWindow(30000);
    check(
      windows.length === 1,
      `Expected one visible ${PRODUCT_NAME} window of at least ${MIN_WINDOW.width} × ${MIN_WINDOW.height}, found ${JSON.stringify(appWindows())}`,
    );
    const [window] = windows;
    console.log(
      `rust-packaged-smoke: window ${window.id} ${window.width} × ${window.height}, ${window.mapState}, pid ${window.pid}, WM_CLASS ${window.wmClass}`,
    );
    await sleep(5000);
    check(process_.exitCode === null && process_.signalCode === null, 'The app exited');
    check(
      appWindows().some((each) => each.id === window.id),
      'The window disappeared while the app was running',
    );
    if (screenshot) {
      const dump = path.join(scratch, 'screen.xwd');
      tool('xwd', ['-root', '-silent', '-out', dump]);
      xwdToPng(dump, screenshot);
      console.log(`rust-packaged-smoke: screenshot ${screenshot}`);
    }

    // The page as the app itself pictures it (WebKitGTK), as for a research
    // screenshot, at the same moment as the screen capture above.
    writeFileSync(path.join(appData, 'run/smoke-snapshot.request'), '');
    const until = Date.now() + 30000;
    while (!existsSync(snapshot) && !existsSync(snapshotFailure) && Date.now() < until)
      await sleep(250);
    check(
      !existsSync(snapshotFailure),
      `The app could not picture its window: ${existsSync(snapshotFailure) ? readFileSync(snapshotFailure, 'utf8') : ''}`,
    );
    const picture = existsSync(snapshot) ? pngSize(snapshot) : null;
    check(picture, 'The app did not picture its window within 30 seconds of being asked');
    check(
      picture.width === window.width && picture.height === window.height,
      `The webview snapshot is ${picture.width} × ${picture.height}, the window ${window.width} × ${window.height}`,
    );
    console.log(
      `rust-packaged-smoke: webview snapshot ${picture.width} × ${picture.height} (${picture.bytes} bytes PNG)`,
    );
    if (screenshot) {
      const copy = screenshot.replace(/(\.png)?$/, '-webview.png');
      copyFileSync(snapshot, copy);
      chmodSync(copy, 0o644);
    }

    // The stand-in agent: a real terminal session of its own that reached the bridge.
    check(Number.isInteger(grant.agentPid), `No stand-in agent session: ${JSON.stringify(grant)}`);
    check(await untilExists(agentOut, process_, 30000), 'The stand-in agent did not report back');
    const report = Object.fromEntries(
      readFileSync(agentOut, 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
    );
    const agentSummary = readFileSync(`${agentOut}.summary`, 'utf8');
    check(
      report.status === '0' && JSON.parse(agentSummary).project?.id === grant.projectId,
      `The stand-in agent could not reach the bridge (status ${report.status}): ${agentSummary}`,
    );
    check(
      realpathSync(report.helper) === realpathSync(helper),
      `The agent's PATH found ${report.helper}, not the packaged helper ${helper}`,
    );
    const { pgid, sid } = groupOf(grant.agentPid);
    check(
      Number(report.pid) === grant.agentPid && pgid === grant.agentPid && sid === grant.agentPid,
      `The stand-in agent is not the leader of its own session and group: pid ${report.pid}, pgid ${pgid}, sid ${sid}`,
    );
    console.log(
      `rust-packaged-smoke: stand-in agent pid ${grant.agentPid} (own session and group) called project.summary through ${report.helper}`,
    );

    // Quit the way a session logout or `kill` asks: SIGTERM to the app itself.
    const appPid = Number(window.pid) || process_.pid;
    process.kill(appPid, 'SIGTERM');
    check(await ended(process_, 30000), 'The app was still running 30 seconds after SIGTERM');
    check(
      process_.exitCode === 0 && process_.signalCode === null,
      `The app did not quit through its exit path on SIGTERM: exit code ${process_.exitCode}, signal ${process_.signalCode}`,
    );
    const groupGone = Date.now() + 10000;
    while (groupAlive(grant.agentPid) && Date.now() < groupGone) await sleep(100);
    check(
      !groupAlive(grant.agentPid),
      `The agent's process group ${grant.agentPid} outlived the app`,
    );
    // A mounted AppImage (FUSE) unmounts once the app has ended. One unpacked
    // with APPIMAGE_EXTRACT_AND_RUN keeps its folder: the AppImage runtime
    // (type2-runtime 8f39b89) leaves it after every exit, a clean one too.
    let imageState = '';
    if (image && path.basename(image).startsWith('appimage_extracted_')) {
      imageState = `, ${image} kept by the AppImage runtime (removed by the smoke)`;
      rmSync(image, { recursive: true, force: true });
    } else if (image) {
      const unmounted = Date.now() + 10000;
      while (existsSync(image) && Date.now() < unmounted) await sleep(100);
      check(!existsSync(image), `The AppImage left its mount ${image} behind`);
      imageState = `, ${image} unmounted`;
    }
    console.log(
      `rust-packaged-smoke: SIGTERM to pid ${appPid}: exit status 0, agent process group ${grant.agentPid} gone${imageState}, window state ${
        existsSync(path.join(appData, 'window-state.json'))
          ? 'saved'
          : 'not saved (never moved or resized)'
      }`,
    );
    console.log(`Linux package smoke passed: ${executable}`);
  } finally {
    if (process_.exitCode === null && process_.signalCode === null) {
      killTree(process_, 'SIGTERM');
      await Promise.race([new Promise((resolve) => process_.once('exit', resolve)), sleep(5000)]);
    }
    killTree(process_, 'SIGKILL');
    // Give an AppImage runtime a moment to remove what it unpacked.
    await sleep(500);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function cargo(args, options = {}) {
  const run = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', ...options });
  if (run.status !== 0) throw new Error(`cargo ${args.join(' ')} failed`);
  return run.stdout;
}

function post(port, token, route, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve(JSON.parse(data)));
      },
    );
    request.on('error', reject);
    request.end(text);
  });
}

async function smokeHeadless() {
  cargo(['build', '--locked', '-p', 'omenflow-headless'], { stdio: 'inherit' });
  const target = JSON.parse(
    cargo(['metadata', '--no-deps', '--format-version', '1']),
  ).target_directory;
  const host = path.join(target, 'debug', exe('omenflow-host'));
  const helper = path.join(root, 'native/omenflow-bridge/target/release', exe('omenflow'));
  if (!existsSync(helper)) throw new Error(`Build the helper first (pnpm build:bridge): ${helper}`);
  checkUsage(helper);
  const scratch = mkdtempSync(path.join(tmpdir(), 'omf-smoke-'));
  const process_ = spawn(host, ['--app-data', path.join(scratch, 'app'), '--cli', helper], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const announced = await new Promise((resolve, reject) => {
      let text = '';
      process_.once('exit', (code) => reject(new Error(`omenflow-host exited with code ${code}`)));
      process_.stdout.setEncoding('utf8');
      process_.stdout.on('data', (chunk) => {
        text += chunk;
        if (text.includes('\n')) resolve(JSON.parse(text.slice(0, text.indexOf('\n'))));
      });
    });
    const created = await post(announced.port, announced.token, '/api/command', {
      op: 'project.create',
      payload: { path: path.join(scratch, 'project'), name: PROJECT_NAME, intent: 'Smoke' },
    });
    check(created.ok, `project.create failed: ${JSON.stringify(created.error)}`);
    const session = await post(announced.port, announced.token, '/api/agent/session', {
      projectId: created.result.projectId,
    });
    check(session.ok, `No agent session: ${JSON.stringify(session.error)}`);
    await agentRoundTrip(helper, session.result);
    await post(announced.port, announced.token, '/api/shutdown', {});
    await Promise.race([new Promise((resolve) => process_.once('exit', resolve)), sleep(5000)]);
    check(process_.exitCode === 0, `omenflow-host did not stop cleanly: ${process_.exitCode}`);
    console.log('Headless smoke passed');
  } finally {
    await stop(process_);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--headless') await smokeHeadless();
else if (process.argv[2] === '--linux') {
  const [executable, flag, screenshot] = process.argv.slice(3);
  if (!executable || (flag && (flag !== '--screenshot' || !screenshot)))
    throw new Error(
      'Usage: rust-packaged-smoke.mjs --linux <installed executable or AppImage> [--screenshot <file.png>]',
    );
  await smokeLinux(path.resolve(executable), screenshot && path.resolve(screenshot));
} else
  await smokeBundle(path.resolve(process.argv[2] ?? 'target/release/bundle/macos/Omen Flow.app'));
