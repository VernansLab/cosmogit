import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev only: serves your extracted logs from ./logs at /logs/<name>.json, plus
 * /logs/index.json listing them. They live outside public/ on purpose, so a
 * production build (and deploy) never includes anyone's private history.
 */
function localLogs(): Plugin {
  return {
    name: 'local-logs',
    configureServer(server) {
      const dir = join(server.config.root, 'logs');
      server.middlewares.use('/logs', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''));
        if (name === 'index.json') {
          let names: string[] = [];
          try {
            names = readdirSync(dir).filter((n) => n.endsWith('.json'));
          } catch {}
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(names));
          return;
        }
        const file = join(dir, name.replace(/[^\w.-]+/g, '_'));
        if (!name.endsWith('.json') || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(file));
      });
    },
  };
}

/** Dev only: POST /__cosmogit/save?name=x.mp4 writes the body to ./exports. */
function saveExports(): Plugin {
  return {
    name: 'save-exports',
    configureServer(server) {
      server.middlewares.use('/__cosmogit/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://x');
        // Keep it to a plain file name inside ./exports.
        const name = (url.searchParams.get('name') ?? 'cosmogit.mp4').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = join(server.config.root, 'exports');
          mkdirSync(dir, { recursive: true });
          const path = join(dir, name);
          writeFileSync(path, Buffer.concat(chunks));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ path }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [localLogs(), saveExports()],
  server: { port: 5178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
