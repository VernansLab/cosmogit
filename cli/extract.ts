import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { GIT_LOG_ARGS, parseGitLog } from '../src/data/parse';
import type { RepoLog } from '../src/data/types';

export interface ExtractOptions {
  /** Follow only the mainline; exact final tree, but branch work shows up as merge commits. */
  firstParent?: boolean;
}

export function extract(repoPath: string, opts: ExtractOptions = {}): RepoLog {
  const dir = resolve(repoPath);
  const args = [...GIT_LOG_ARGS, ...(opts.firstParent ? ['--first-parent'] : [])];
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git log failed in ${dir}: ${res.stderr}`);
  return parseGitLog(res.stdout, basename(dir));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const firstParent = argv.includes('--first-parent');
  const [repo = '.', out] = argv.filter((a) => !a.startsWith('--'));
  const log = extract(repo, { firstParent });
  const target = out ?? `${log.repo}.json`;
  writeFileSync(target, JSON.stringify(log));
  const changes = log.commits.reduce((n, c) => n + c.changes.length, 0);
  console.log(`${log.repo}: ${log.commits.length} commits, ${log.authors.length} authors, ${changes} changes -> ${target}`);
}
