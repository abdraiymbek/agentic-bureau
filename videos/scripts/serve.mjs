// Static server rooted at the repository so the trailer can load the canonical
// design-system tokens, vendored fonts, and brand assets without copies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return res.writeHead(404).end('not found');
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.env.PORT ?? 4173));
  console.log(`Trailer preview: http://127.0.0.1:${port}/videos/trailer/`);
}
