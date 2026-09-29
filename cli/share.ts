/**
 * Publish a repo's history at an unlisted link:
 *
 *   pnpm share ~/code/my-repo [--first-parent] [--new] [--no-pull]
 *
 * Pulls the repo (fast-forward only), extracts its history, strips author
 * emails, writes shared/<id>.json and deploys. The same repo keeps the same
 * link on every run; --new rotates it (the old link stops working).
 *
 * shared/ is gitignored and copied into dist/s/ at build time, so deploys
 * from this machine keep the links alive. A deploy from a checkout without
 * shared/ would drop them.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './extract';

const SITE = 'https://cosmogit.web.app';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = join(root, 'shared');
const indexFile = join(sharedDir, 'index.json');

const argv = process.argv.slice(2);
const repoArg = argv.find((a) => !a.startsWith('--'));
if (!repoArg) {
  console.error('usage: pnpm share <repo> [--first-parent] [--new] [--no-pull]');
  process.exit(1);
}
const repo = resolve(repoArg);

function run(cmd: string, args: string[], cwd = root): boolean {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  return r.status === 0;
}

if (!argv.includes('--no-pull')) {
  console.log(`↓ pulling ${repo}`);
  if (!run('git', ['-C', repo, 'pull', '--ff-only'])) console.warn('  pull failed; sharing the history as it is locally');
}

const log = extract(repo, { firstParent: argv.includes('--first-parent') });
for (const a of log.authors) a.email = '';

mkdirSync(sharedDir, { recursive: true });
const index: Record<string, string> = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
let id = index[repo];
if (!id || argv.includes('--new')) {
  if (id) rmSync(join(sharedDir, `${id}.json`), { force: true });
  id = randomBytes(12).toString('base64url');
  index[repo] = id;
}
writeFileSync(join(sharedDir, `${id}.json`), JSON.stringify(log));
writeFileSync(indexFile, JSON.stringify(index, null, 2));
console.log(`✔ ${log.repo}: ${log.commits.length.toLocaleString()} commits, ${log.authors.length} authors (emails removed)`);

if (!run('pnpm', ['build'])) process.exit(1);
if (!run('firebase', ['deploy', '--only', 'hosting', '--project', 'cosmogit', '--account', 'max@flach.io'])) process.exit(1);

console.log(`\n  Share: ${SITE}/s/${id}\n`);
