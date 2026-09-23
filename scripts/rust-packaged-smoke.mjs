#!/usr/bin/env node
/** Launch the actual app bundle with disposable state and exercise its v1 socket. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const app = path.resolve(process.argv[2] ?? 'target/release/bundle/macos/Omen Flow.app');
const executable = path.join(app, 'Contents/MacOS/omenflow-rust-desktop');
const helper = path.join(app, 'Contents/Resources/omenflow');
if (!existsSync(executable) || !existsSync(helper))
  throw new Error(`Incomplete Rust bundle: ${app}`);
const usage = spawnSync(helper, [], { encoding: 'utf8' });
if (
  usage.status !== 3 ||
  !usage.stderr.includes('omenflow call') ||
  !usage.stderr.includes('omenflow mcp')
)
  throw new Error('Bundled Rust bridge CLI is incomplete');
const scratch = mkdtempSync(path.join(tmpdir(), 'omenflow-rust-smoke-'));
const socket = path.join(scratch, 'run/bridge.sock');
console.log('rust-packaged-smoke: launching');
const process_ = spawn(executable, [], {
  env: { ...process.env, OMENFLOW_APP_DATA_DIR: scratch },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const until = Date.now() + 12000;
  while (!existsSync(socket) && process_.exitCode === null && Date.now() < until) await sleep(100);
  if (!existsSync(socket)) throw new Error('Rust app did not create its bridge socket');
  console.log(`rust-packaged-smoke: bridge at ${socket}`);
  const response = await new Promise((resolve, reject) => {
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
  if (response.error?.code !== 'CONNECTION_DENIED')
    throw new Error(`Unexpected unauthenticated bridge response: ${JSON.stringify(response)}`);
  console.log(`Rust bundle smoke passed: ${app}`);
} finally {
  process_.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => process_.once('exit', resolve)), sleep(3000)]);
  rmSync(scratch, { recursive: true, force: true });
}
