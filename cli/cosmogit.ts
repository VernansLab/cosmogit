import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { extractPath } from './source';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const repo = argv.find((a) => !a.startsWith('--')) ?? '.';

const log = extractPath(repo, { firstParent: argv.includes('--first-parent') });
const slug = log.repo.replace(/[^\w.-]+/g, '_');
mkdirSync(join(root, 'logs'), { recursive: true });
writeFileSync(join(root, 'logs', `${slug}.json`), JSON.stringify(log));
console.log(`${log.repo}: ${log.commits.length} commits, ${log.authors.length} authors`);

const server = await createServer({ root, server: { open: `/?log=logs/${slug}.json` } });
await server.listen();
server.printUrls();
