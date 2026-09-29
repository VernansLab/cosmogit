import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { combine } from '../src/data/combine';
import { GIT_LOG_ARGS, parseGitLog } from '../src/data/parse';
import type { RepoLog } from '../src/data/types';

export interface ExtractOptions {
  /** Follow only the mainline; exact final tree, but branch work shows up as merge commits. */
  firstParent?: boolean;
}

/** The top of the repo containing `dir`, or null if it isn't inside one. */
export function repoRoot(dir: string): string | null {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Git repos directly inside `dir` (a workspace folder of repos). */
export function childRepos(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((n) => join(dir, n))
    .filter((p) => existsSync(join(p, '.git')));
}

export function extractRepo(repoPath: string, opts: ExtractOptions = {}): RepoLog {
  const dir = resolve(repoPath);
  const args = [...GIT_LOG_ARGS, ...(opts.firstParent ? ['--first-parent'] : [])];
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git log failed in ${dir}: ${res.stderr}`);
  return parseGitLog(res.stdout, basename(dir));
}

/** The repos a path stands for: itself if it's inside a repo, else the repos directly inside it. */
export function reposFor(path: string): string[] {
  const dir = resolve(path);
  const root = repoRoot(dir);
  if (root) return [root];
  return childRepos(dir);
}

/**
 * Extract one repo, or combine several. A path inside a repo means that repo;
 * a folder that isn't a repo means every repo directly inside it.
 */
export function extractPath(path: string, opts: ExtractOptions = {}): RepoLog {
  const dir = resolve(path);
  const repos = reposFor(dir);
  if (!repos.length) throw new Error(`${dir} is not a git repo and has no git repos directly inside it`);
  if (repos.length === 1 && repos[0] === repoRoot(dir)) return extractRepo(repos[0], opts);
  const logs = repos.map((r) => extractRepo(r, opts)).filter((l) => l.commits.length);
  return combine(logs, basename(dir));
}

/** Combine an explicit list of repos (or repo folders) under one name. */
export function extractPaths(paths: string[], name: string, opts: ExtractOptions = {}): RepoLog {
  if (paths.length === 1) return extractPath(paths[0], opts);
  const repos = paths.flatMap((p) => reposFor(p));
  return combine(repos.map((r) => extractRepo(r, opts)).filter((l) => l.commits.length), name);
}
