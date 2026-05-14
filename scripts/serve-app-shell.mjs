import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const [, , rootArg = 'desktop', portArg = '4321'] = process.argv;
const root = resolve(process.cwd(), rootArg);
const port = Number(portArg);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`Static app root does not exist: ${root}`);
}

function getPortOwner(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  const requestPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = normalize(join(root, requestPath));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type':
      MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    const owner = getPortOwner(port);
    console.error(`Port ${port} is already in use.`);
    if (owner) {
      console.error(owner);
    }
    console.error(`Stop the existing preview server or run:`);
    console.error(`  node scripts/serve-app-shell.mjs desktop <port>`);
    process.exitCode = 1;
    return;
  }

  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}`);
});
