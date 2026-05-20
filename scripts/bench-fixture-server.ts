/**
 * Tiny static HTTP server for bench fixture files.
 *
 * Serves the four HTML files in scripts/bench-fixtures/ on localhost:7777
 * (port configurable via BENCH_FIXTURE_PORT env). The bench script starts
 * this server before running and stops it in a finally block on exit.
 *
 * start() resolves once the server is listening.
 * stop() resolves once the server is fully closed.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'bench-fixtures');

export const FIXTURE_PORT = parseInt(process.env.BENCH_FIXTURE_PORT ?? '7777', 10);

let server: http.Server | null = null;

export function startFixtureServer(): Promise<void> {
  if (server) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${FIXTURE_PORT}`);
      const filename = url.pathname.replace(/^\//, '');
      if (!filename || filename.includes('..') || !filename.endsWith('.html')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found\n');
        return;
      }
      const filepath = path.join(FIXTURES_DIR, filename);
      if (!filepath.startsWith(FIXTURES_DIR)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden\n');
        return;
      }
      fs.readFile(filepath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found\n');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(data);
      });
    });

    s.on('error', reject);
    // Bind to all interfaces so Apple Container VMs (bridge network) can reach
    // the server via the host gateway IP (e.g. 192.168.64.1), not just 127.0.0.1.
    s.listen(FIXTURE_PORT, '0.0.0.0', () => {
      server = s;
      resolve();
    });
  });
}

export function stopFixtureServer(): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server!.close((err) => {
      server = null;
      if (err) reject(err);
      else resolve();
    });
  });
}
