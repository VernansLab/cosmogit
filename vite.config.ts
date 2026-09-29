import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Shared links: shared/<id>.json (gitignored, written by `pnpm share`) is
 * served at /s/<id>.json in dev and copied to dist/s/ on build.
 */
function sharedLogs(): Plugin {
  let root = '';
  let outDir = '';
  const files = () => {
    try {
      return readdirSync(join(root, 'shared')).filter((n) => n.endsWith('.json') && n !== 'index.json');
    } catch {
      return [];
    }
  };
  return {
    name: 'shared-logs',
    configResolved(config) {
      root = config.root;
      outDir = join(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/s', (req, res, next) => {
        const name = (req.url ?? '/').split('?')[0].replace(/^\//, '');
        if (!files().includes(name)) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(join(root, 'shared', name)));
      });
    },
    closeBundle() {
      const names = files();
      if (!names.length) return;
      mkdirSync(join(outDir, 's'), { recursive: true });
      for (const n of names) copyFileSync(join(root, 'shared', n), join(outDir, 's', n));
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
  plugins: [localLogs(), sharedLogs(), saveExports()],
  server: { port: 5178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
