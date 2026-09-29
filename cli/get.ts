/**
 * The script behind the one-liner on cosmogit.web.app:
 *
 *   curl -fsSL https://cosmogit.web.app/get | node
 *   curl -fsSL https://cosmogit.web.app/get | node - --first-parent
 *
 * Run inside a git repo. Writes <repo>.cosmogit.json to the current
 * directory. Nothing is uploaded anywhere; the viewer reads the file locally.
 * Bundled to a single CommonJS file (dist/get) by `pnpm build`.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GIT_LOG_ARGS, parseGitLog } from '../src/data/parse';

const SITE = 'https://cosmogit.web.app';

function fail(msg: string): never {
  console.error(`cosmogit: ${msg}`);
  process.exit(1);
}

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0) fail('not inside a git repository. cd into one and run it again.');
const root = top.stdout.trim();
const name = basename(root);

const firstParent = process.argv.includes('--first-parent');
const res = spawnSync('git', ['-C', root, ...GIT_LOG_ARGS, ...(firstParent ? ['--first-parent'] : [])], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024 * 1024,
});
if (res.status !== 0) fail(`git log failed: ${res.stderr.trim()}`);

const log = parseGitLog(res.stdout, name);
if (!log.commits.length) fail('this repository has no commits yet.');

const file = `${name.replace(/[^\w.-]+/g, '_')}.cosmogit.json`;
const out = join(process.cwd(), file);
writeFileSync(out, JSON.stringify(log));
const changes = log.commits.reduce((n, c) => n + c.changes.length, 0);
console.log(`✔ ${out}`);
console.log(`  ${log.commits.length.toLocaleString()} commits · ${log.authors.length.toLocaleString()} authors · ${changes.toLocaleString()} file changes`);
console.log(`  Drop it on ${SITE} to watch your galaxy form.`);
