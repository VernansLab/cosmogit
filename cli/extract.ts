import { writeFileSync } from 'node:fs';
import { extractPaths } from './source';

/**
 *   pnpm extract <repo | folder of repos> [more repos…] [--out file.json] [--name name] [--first-parent]
 */
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const paths = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--name');
const log = extractPaths(paths.length ? paths : ['.'], flag('--name') ?? 'combined', { firstParent: argv.includes('--first-parent') });
const target = flag('--out') ?? `${log.repo}.json`;
writeFileSync(target, JSON.stringify(log));
const changes = log.commits.reduce((n, c) => n + c.changes.length, 0);
const repos = log.repos ? ` from ${log.repos.length} repos` : '';
console.log(`${log.repo}: ${log.commits.length} commits${repos}, ${log.authors.length} authors, ${changes} changes -> ${target}`);
