/**
 * The script behind the one-liner on cosmogit.web.app:
 *
 *   curl -fsSL https://cosmogit.web.app/get | node
 *   curl -fsSL https://cosmogit.web.app/get | node - --first-parent
 *
 * Run inside a git repo, or in a folder that contains several repos to combine
 * them into one galaxy. Writes <name>.cosmogit.json to the current directory.
 * Nothing is uploaded anywhere; the viewer reads the file locally.
 * Bundled to a single CommonJS file (dist/get) by `pnpm build`.
 */
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { childRepos, extractPath, repoRoot } from './source';

const SITE = 'https://cosmogit.web.app';

function fail(msg: string): never {
  console.error(`cosmogit: ${msg}`);
  process.exit(1);
}

const cwd = process.cwd();
const root = repoRoot(cwd);
const children = root ? [] : childRepos(cwd);
if (!root && !children.length) fail('not inside a git repository, and no repositories in this folder. cd into one and run it again.');
if (children.length) console.log(`Combining ${children.length} repos: ${children.map((c) => basename(c)).join(', ')}`);

let log;
try {
  log = extractPath(root ?? cwd, { firstParent: process.argv.includes('--first-parent') });
} catch (err) {
  fail((err as Error).message);
}
if (!log.commits.length) fail('no commits found.');

const file = `${log.repo.replace(/[^\w.-]+/g, '_')}.cosmogit.json`;
const out = join(cwd, file);
writeFileSync(out, JSON.stringify(log));
const changes = log.commits.reduce((n, c) => n + c.changes.length, 0);
console.log(`✔ ${out}`);
console.log(`  ${log.commits.length.toLocaleString()} commits · ${log.authors.length.toLocaleString()} authors · ${changes.toLocaleString()} file changes`);
console.log(`  Drop it on ${SITE} to watch your galaxy form.`);
