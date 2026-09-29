import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Serves /logs/index.json listing the extracted logs in public/logs. */
function logIndex(): Plugin {
  return {
    name: 'log-index',
    configureServer(server) {
      server.middlewares.use('/logs/index.json', (_req, res) => {
        let names: string[] = [];
        try {
          names = readdirSync(join(server.config.root, 'public/logs')).filter((n) => n.endsWith('.json') && n !== 'index.json');
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(names));
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
  plugins: [logIndex(), saveExports()],
  server: { port: 5178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
