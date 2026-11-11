#!/usr/bin/env node
// Serves the production build (dist/) with the Content Security Policy of tauri.conf.json, so the editor's
// worker and WebAssembly can be checked under it in a browser (CLAUDE.md §6). No backend: queries fail.
// Usage: pnpm build && pnpm preview:csp [port]
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist/schema-commander/browser');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** The policy the packaged app runs under. */
export function readCsp(root = ROOT) {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  return conf.app.security.csp;
}

/** The file a request path means inside `dist`; everything unknown is the app itself. */
export function resolveFile(dist, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = join(dist, clean);
  const inside = file.startsWith(dist);
  return inside && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 1461);
  const csp = readCsp();
  createServer((req, res) => {
    const file = resolveFile(DIST, new URL(req.url, 'http://localhost').pathname);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp,
    });
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port} (CSP: ${csp})`));
}
