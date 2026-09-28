import { readdirSync } from 'node:fs';
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

export default defineConfig({
  plugins: [logIndex()],
  server: { port: 5178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
